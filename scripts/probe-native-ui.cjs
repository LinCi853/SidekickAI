'use strict'

// Runtime proof that a built native wizard/uninstaller serves its own embedded UI.
//
// The static byte check in verify-embedded-web.cjs proves the assets are inside the
// executable. This check proves the whole path works end to end: Tauri registers its
// production custom protocol, the webview asks for the app URL, the asset resolver
// answers from the embedded map, and the resulting document is the real page.
//
// It is used as a manual/CI gate:
//   node scripts/probe-native-ui.cjs <exe> [expected-title-regex] [--uninstall]
//
// Safety model (this is why the file is longer than a naive launcher):
//   * The probe NEVER terminates processes by image name. `taskkill /IM <name> /T`
//     can kill a real user's running installer, so it is forbidden here.
//   * The executable is copied into a unique fixture directory and that copy is what
//     runs. Every process the probe owns is bound to the exact fixture copy (PID plus
//     creation time plus image path), never to a name.
//   * The standalone uninstaller relocates itself into `%TEMP%\SidekickAI-Uninstall`
//     before showing its UI. Those copies are recognised only through a relocation
//     `bootstrap.json` whose `sourceExe` and `sourceSha256` name this exact fixture
//     copy, and they are terminated only after re-reading their live identity.
//   * `WEBVIEW2_USER_DATA_FOLDER` points at the fixture directory, so a probe can never
//     read or write the real application's webview profile.
//
// The probe only opens the UI and reads the page. It never clicks start and never
// executes an uninstall.

const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const OPERATION_ROOT_NAME = 'SidekickAI-Uninstall'
const RELOCATED_IMAGE_NAME = 'uninstaller-ui.exe'
const DEFAULT_TITLE = /向导/
const MAX_FIXTURE_IDENTITY_ATTEMPTS = 10
const TERMINATION_SETTLE_MS = 250
// PowerShell 5.1 serializes `CreationDate` as `\/Date(ticks)\/`, PowerShell 7 as an
// ISO string, so ask for ticks directly and cast to a string: a .NET tick count
// exceeds Number.MAX_SAFE_INTEGER and JSON would silently round it.
const PROCESS_QUERY_SCRIPT = [
  'Get-CimInstance Win32_Process',
  '| ForEach-Object { [pscustomobject]@{ processId = $_.ProcessId; parentProcessId = $_.ParentProcessId;',
  'name = $_.Name; executablePath = $_.ExecutablePath;',
  'creationDate = $(if ($_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { $null });',
  'commandLine = $_.CommandLine } }',
  '| ConvertTo-Json -Compress -Depth 2',
].join(' ')

// ---------------------------------------------------------------------------
// Pure helpers (unit tested without touching processes or the network)
// ---------------------------------------------------------------------------

/** Normalize a Windows path for identity comparison (case- and separator-insensitive). */
function normalizeWindowsPath(value) {
  const normalized = path.win32.normalize(String(value))
  return normalized.replace(/[\\/]+$/, '').toLowerCase()
}

/** True when two paths name the same Windows image. */
function sameExecutablePath(left, right) {
  if (!left || !right) return false
  return normalizeWindowsPath(left) === normalizeWindowsPath(right)
}

/** True when a fresh process row still has the identity captured earlier. */
function sameProcessIdentity(captured, current) {
  if (!captured || !current || captured.processId !== current.processId) return false
  if (!captured.creationDate || !current.creationDate || captured.creationDate !== current.creationDate) return false
  if (!captured.executablePath || !current.executablePath || !sameExecutablePath(captured.executablePath, current.executablePath)) return false
  return true
}

/**
 * The production Tauri protocol is exactly `http(s)://tauri.localhost`. A `file://`
 * path into the build machine, a dev server on `localhost`, or any other origin
 * means the UI was not served from the embedded asset map.
 */
function isEmbeddedAppUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.hostname.toLowerCase() !== 'tauri.localhost') return false
  if (url.port !== '' || url.username !== '' || url.password !== '') return false
  return true
}

/** `RegExp.test` is stateful for `/g` patterns; always test from the start. */
function matchesTitle(expectedTitle, title) {
  if (!(expectedTitle instanceof RegExp)) return false
  expectedTitle.lastIndex = 0
  return expectedTitle.test(String(title))
}

/**
 * Parse exactly one WebSocket frame from the head of `buffer`.
 *
 * Returns `null` while the header or payload is still incomplete (TCP hands us
 * arbitrary chunks, so extended lengths can be split across reads), otherwise
 * `{ fin, opcode, payload, consumed }`. Server frames are normally unmasked, but
 * masked frames are decoded too so a proxy cannot corrupt the payload.
 */
function readWebSocketFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    const declared = buffer.readBigUInt64BE(2)
    if (declared > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame declares an impossible length')
    length = Number(declared)
    offset = 10
  }
  if (masked && buffer.length < offset + 4) return null
  const dataOffset = masked ? offset + 4 : offset
  if (buffer.length < dataOffset + length) return null
  const payload = Buffer.from(buffer.subarray(dataOffset, dataOffset + length))
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
  }
  return { fin, opcode, payload, consumed: dataOffset + length }
}

/** Encode one masked client text frame (clients MUST mask, servers MUST NOT). */
function encodeWebSocketFrame(text, mask = crypto.randomBytes(4)) {
  if (!Buffer.isBuffer(mask) || mask.length !== 4) throw new Error('a websocket mask must be four bytes')
  const payload = Buffer.from(String(text), 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | payload.length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  header[0] = 0x81
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4]
  return Buffer.concat([header, mask, masked])
}

/** Normalize a `Win32_Process` JSON dump (PowerShell emits an object for one row). */
function parseProcessSnapshot(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      processId: Number(row.processId),
      parentProcessId: Number(row.parentProcessId),
      name: typeof row.name === 'string' ? row.name : '',
      executablePath: typeof row.executablePath === 'string' ? row.executablePath : '',
      creationDate: row.creationDate == null ? '' : String(row.creationDate),
      commandLine: typeof row.commandLine === 'string' ? row.commandLine : '',
    }))
    .filter(row => Number.isInteger(row.processId) && row.processId > 0)
}

/**
 * A relocation bootstrap is evidence only when it names this exact fixture copy:
 * same source path and the same image hash. A same-named `uninstaller-ui.exe` from
 * a real user's uninstall has a different sourceExe and is therefore never touched.
 */
function matchRelocatedBootstrap(bootstrap, identity) {
  if (!bootstrap || typeof bootstrap !== 'object' || !identity) return false
  if (typeof bootstrap.sourceExe !== 'string' || !bootstrap.sourceExe) return false
  if (typeof bootstrap.sourceSha256 !== 'string' || !bootstrap.sourceSha256) return false
  if (typeof identity.sourceSha256 !== 'string' || !identity.sourceSha256) return false
  if (!sameExecutablePath(bootstrap.sourceExe, identity.sourceExe)) return false
  return bootstrap.sourceSha256.toLowerCase() === identity.sourceSha256.toLowerCase()
}

/** Read-only scan for relocations that belong to `identity`; never deletes anything. */
function discoverOwnedRelocations(operationRoot, identity, { readFile = fs.readFileSync, readdir = fs.readdirSync } = {}) {
  const found = []
  if (!operationRoot || !identity) return found
  let entries
  try {
    entries = readdir(operationRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ui-')) continue
    const directory = path.join(operationRoot, entry.name)
    let bootstrap
    try {
      bootstrap = JSON.parse(readFile(path.join(directory, 'bootstrap.json'), 'utf8'))
    } catch {
      continue
    }
    if (!matchRelocatedBootstrap(bootstrap, identity)) continue
    found.push({ directory, bootstrap, exe: path.join(directory, RELOCATED_IMAGE_NAME) })
  }
  return found
}

/**
 * Select the live processes the probe is allowed to stop: the recorded roots plus
 * their descendants. Roots are matched on PID *and* creation time *and* image path,
 * so a recycled PID is never mistaken for an owned process, and a descendant must
 * have an owned ancestor in the same snapshot.
 */
function selectOwnedProcesses(rows, roots) {
  const byPid = new Map(rows.map(row => [row.processId, row]))
  const isRoot = row => roots.some(root => sameProcessIdentity(root, row))
  const ownedAncestor = row => {
    const seen = new Set()
    let current = row
    while (current && !seen.has(current.processId)) {
      seen.add(current.processId)
      if (isRoot(current)) return true
      const parent = current.parentProcessId ? byPid.get(current.parentProcessId) : undefined
      if (parent && (!current.creationDate || !parent.creationDate || BigInt(parent.creationDate) > BigInt(current.creationDate))) return false
      current = parent
    }
    return false
  }
  return rows.filter(ownedAncestor)
}

function describeProcess(row) {
  return {
    pid: row.processId,
    name: row.name || undefined,
    executablePath: row.executablePath || undefined,
    creationDate: row.creationDate || undefined,
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Copy the target into a unique fixture directory so the probe owns a disposable
 * image: relocated copies can be tied back to it by path and hash, and the webview
 * profile lives inside the same directory.
 */
function prepareProbeFixture(exe, { temporaryRoot = os.tmpdir() } = {}) {
  const name = path.basename(String(exe))
  if (!name) throw new Error(`cannot prepare a probe copy of ${JSON.stringify(exe)}: no file name`)
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'sidekick-ui-probe-'))
  const fixture = path.join(directory, name)
  fs.copyFileSync(exe, fixture)
  const sha256 = sha256File(fixture)
  const webviewDataDir = path.join(directory, 'webview2')
  const tempDir = path.join(directory, 'temp')
  fs.mkdirSync(webviewDataDir, { recursive: true })
  fs.mkdirSync(tempDir)
  return { directory, exe: fixture, sha256, webviewDataDir, tempDir }
}

/** The child's environment: its own webview profile and the given CDP port. */
function buildProbeEnvironment(baseEnvironment, fixture, port) {
  return {
    ...baseEnvironment,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: fixture.webviewDataDir,
    ...(fixture.tempDir ? { TEMP: fixture.tempDir, TMP: fixture.tempDir } : {}),
  }
}

function parseCommandLineArguments(argv) {
  const positional = []
  const appArgs = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--uninstall') appArgs.push('--uninstall')
    else if (token === '--arg') {
      const value = argv[++index]
      if (value === undefined) throw new Error('--arg requires a value')
      appArgs.push(value)
    } else if (token.startsWith('--arg=')) appArgs.push(token.slice('--arg='.length))
    else if (token.startsWith('--')) throw new Error(`unknown probe option: ${token}`)
    else positional.push(token)
  }
  return { exe: positional[0], title: positional[1], appArgs }
}

// ---------------------------------------------------------------------------
// Platform and network access (injected/overridden by the tests)
// ---------------------------------------------------------------------------

function listWindowsProcesses() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY_SCRIPT], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(`cannot enumerate processes: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`cannot enumerate processes: ${(result.stderr || '').trim() || `exit ${result.status}`}`)
  return parseProcessSnapshot(result.stdout)
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: urlPath }, response => {
      let body = ''
      response.on('data', chunk => (body += chunk))
      response.on('end', () => resolve(body))
    })
    request.on('error', reject)
    request.setTimeout(2000, () => request.destroy(new Error('request timeout')))
  })
}

function evaluate(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl)
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    })
    let settled = false
    const timer = setTimeout(() => { request.destroy(); finish(new Error('websocket timeout')) }, timeoutMs)
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    request.on('upgrade', (response, socket) => {
      const message = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })
      try {
        socket.write(encodeWebSocketFrame(message))
      } catch (error) {
        socket.destroy()
        finish(error)
        return
      }
      let buffer = Buffer.alloc(0)
      let fragmentOpcode = null
      let fragments = []
      const deliver = text => {
        try {
          const reply = JSON.parse(text)
          socket.destroy()
          finish(null, reply.result && reply.result.result ? reply.result.result.value : undefined)
        } catch (error) {
          socket.destroy()
          finish(error)
        }
      }
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          let frame
          try {
            frame = readWebSocketFrame(buffer)
          } catch (error) {
            socket.destroy()
            finish(error)
            return
          }
          if (!frame) return
          buffer = buffer.subarray(frame.consumed)
          if (frame.opcode === 0x8) {
            socket.destroy()
            finish(new Error('websocket closed before a reply'))
            return
          }
          if (frame.opcode === 0x9 || frame.opcode === 0xa) continue
          if (frame.opcode === 0x0) {
            if (fragmentOpcode === null) {
              socket.destroy()
              finish(new Error('unexpected websocket continuation frame'))
              return
            }
            fragments.push(frame.payload)
            if (!frame.fin) continue
            const complete = Buffer.concat(fragments)
            const opcode = fragmentOpcode
            fragments = []
            fragmentOpcode = null
            if (opcode === 0x1) {
              deliver(complete.toString('utf8'))
              return
            }
            continue
          }
          if (frame.opcode !== 0x1) continue
          if (!frame.fin) {
            fragmentOpcode = frame.opcode
            fragments = [frame.payload]
            continue
          }
          deliver(frame.payload.toString('utf8'))
          return
        }
      })
      socket.on('error', error => finish(error))
      socket.on('close', () => finish(new Error('websocket closed before a reply')))
    })
    request.on('error', error => finish(error))
    request.end()
  })
}

function createDefaultDependencies() {
  return {
    spawn,
    listProcesses: listWindowsProcesses,
    terminate: pid => { process.kill(pid); return true },
    getJson,
    evaluate,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    prepareFixture: exe => prepareProbeFixture(exe),
    removeFixture: directory => fs.rmSync(directory, { recursive: true, force: true }),
    operationRoot: () => path.join(os.tmpdir(), OPERATION_ROOT_NAME),
    readFile: fs.readFileSync,
    readdir: fs.readdirSync,
    now: () => Date.now(),
  }
}

async function processSnapshot(dependencies) {
  const rows = await dependencies.listProcesses()
  if (Array.isArray(rows)) return rows
  return parseProcessSnapshot(rows)
}

/** Wait briefly for the launched PID to appear, then bind PID + creation time + path. */
async function captureRootIdentity(dependencies, processId, executablePath) {
  for (let attempt = 0; attempt < MAX_FIXTURE_IDENTITY_ATTEMPTS; attempt++) {
    let rows = []
    try {
      rows = await processSnapshot(dependencies)
    } catch {
      rows = []
    }
    const row = rows.find(entry => entry.processId === processId)
    if (row) {
      return {
        processId,
        creationDate: row.creationDate || undefined,
        executablePath: row.executablePath || executablePath,
        name: row.name || undefined,
      }
    }
    if (attempt + 1 < MAX_FIXTURE_IDENTITY_ATTEMPTS) await dependencies.sleep(100)
  }
  return { processId, executablePath }
}

/**
 * Terminate only the verified owned processes, then report what is still alive.
 * Every PID is confirmed against a fresh snapshot (same creation time and image
 * path) immediately before it is stopped. If the snapshot cannot be read, nothing
 * is stopped: an unverified kill is worse than a leaked window.
 */
async function cleanupProbeProcesses(dependencies, { roots, identity, selfPid = process.pid }) {
  const cleanup = { relocated: [], owned: [], terminated: [], exited: [], skipped: [], survivors: [], leaked: 0 }
  let rows
  try {
    rows = await processSnapshot(dependencies)
  } catch (error) {
    cleanup.error = `cannot enumerate processes for cleanup: ${error.message}`
    return cleanup
  }
  const rootIdentities = [...roots]
  if (identity) {
    for (const relocation of discoverOwnedRelocations(dependencies.operationRoot(), identity, dependencies)) {
      cleanup.relocated.push({
        directory: relocation.directory,
        exe: relocation.exe,
        nonce: relocation.bootstrap.nonce,
        sourceExe: relocation.bootstrap.sourceExe,
        launcherPid: relocation.bootstrap.pid,
      })
      const live = rows.find(row => sameExecutablePath(row.executablePath, relocation.exe))
      if (live) rootIdentities.push({ processId: live.processId, creationDate: live.creationDate, executablePath: live.executablePath })
    }
  }
  const owned = selectOwnedProcesses(rows, rootIdentities).filter(row => row.processId !== selfPid)
  cleanup.owned = owned.map(describeProcess)

  let current = null
  try {
    current = await processSnapshot(dependencies)
  } catch (error) {
    cleanup.error = `cannot re-verify process identities before cleanup: ${error.message}`
  }
  if (current) {
    for (const row of owned) {
      const live = current.find(entry => entry.processId === row.processId)
      if (!live) {
        cleanup.exited.push(describeProcess(row))
        continue
      }
      if (!sameProcessIdentity(row, live)) {
        cleanup.skipped.push({ ...describeProcess(row), reason: 'process identity changed before termination' })
        continue
      }
      try {
        await dependencies.terminate(row.processId)
        cleanup.terminated.push(describeProcess(row))
      } catch (error) {
        cleanup.terminated.push({ ...describeProcess(row), error: error.message })
      }
    }
  } else {
    cleanup.skipped = owned.map(row => ({ ...describeProcess(row), reason: 'identity could not be re-verified' }))
  }

  await dependencies.sleep(TERMINATION_SETTLE_MS)
  let after = []
  try {
    after = await processSnapshot(dependencies)
  } catch {
    after = []
  }
  cleanup.survivors = selectOwnedProcesses(after, rootIdentities)
    .filter(row => row.processId !== selfPid)
    .map(describeProcess)
  cleanup.leaked = cleanup.survivors.length
  return cleanup
}

/** Launch `exe`, inspect its webview, and report what the page actually is. */
async function probeNativeUi(exe, options = {}) {
  if (!exe || typeof exe !== 'string') throw new Error('a probe executable path is required')
  const expectedTitle = options.expectedTitle instanceof RegExp
    ? options.expectedTitle
    : options.expectedTitle ? new RegExp(options.expectedTitle) : DEFAULT_TITLE
  const timeoutSeconds = options.timeoutSeconds ?? 25
  const appArgs = Array.isArray(options.args) ? options.args.map(String) : []
  const dependencies = { ...createDefaultDependencies(), ...(options.dependencies || {}) }
  const port = options.port ?? 9400 + Math.floor(Math.random() * 400)
  const roots = []
  const report = { executable: exe, port, args: appArgs }
  let fixture = null

  try {
    try {
      fixture = await dependencies.prepareFixture(exe)
    } catch (error) {
      report.ok = false
      report.error = `cannot prepare a probe copy of the executable: ${error.message}`
      return report
    }
    report.fixtureExecutable = fixture.exe
    report.fixtureSha256 = fixture.sha256

    let spawnFailure = null
    let child
    try {
      child = dependencies.spawn(fixture.exe, appArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: fixture.directory,
        env: buildProbeEnvironment(process.env, fixture, port),
      })
    } catch (error) {
      // EINVAL/UNKNOWN from CreateProcess means the host cannot execute this image at
      // all, which is an environment limitation rather than a packaging defect.
      report.ok = false
      report.unrunnable = /UNKNOWN|EINVAL|not a valid Win32|%1 is not a valid/i.test(error.message)
      report.error = `cannot launch the executable: ${error.message}`
      return report
    }
    child.on('error', error => { spawnFailure = error })
    if (typeof child.unref === 'function') child.unref()
    if (Number.isInteger(child.pid) && child.pid > 0) {
      report.launchedPid = child.pid
      roots.push(await captureRootIdentity(dependencies, child.pid, fixture.exe))
    }

    let target
    for (let attempt = 0; attempt < timeoutSeconds && !target; attempt++) {
      if (spawnFailure) break
      await dependencies.sleep(1000)
      if (spawnFailure) break
      try {
        const list = JSON.parse(await dependencies.getJson(port, '/json/list'))
        const pages = list.filter(entry => entry.type === 'page')
        report.pageTargets = pages.length
        target = pages[0]
      } catch { /* the webview is still starting, or the UI relocated itself */ }
    }
    if (!target) {
      report.ok = false
      if (spawnFailure) {
        report.unrunnable = /UNKNOWN|EINVAL|not a valid Win32|%1 is not a valid/i.test(spawnFailure.message)
        report.error = `cannot launch the executable: ${spawnFailure.message}`
      } else {
        report.error = 'the webview never exposed a page target'
      }
      return report
    }

    report.url = target.url
    report.title = target.title
    try {
      report.rootHtmlLength = await dependencies.evaluate(target.webSocketDebuggerUrl, 'document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1')
      report.bodyText = String(await dependencies.evaluate(target.webSocketDebuggerUrl, 'document.body.innerText.slice(0, 120)')).replace(/\s+/g, ' ')
    } catch (error) {
      report.evaluateError = error.message
    }
    // The page must come from the production custom protocol AND mount content into
    // the app root. A disk-loaded build shows either "<drive>:\...\dist\ 的索引"
    // (directory index) or "未找到文件" (file not found) and never mounts the root.
    const title = String(report.title)
    report.embeddedUrl = isEmbeddedAppUrl(report.url)
    report.mountedRoot = Number.isFinite(Number(report.rootHtmlLength)) && Number(report.rootHtmlLength) > 0
    report.ok = report.embeddedUrl
      && report.mountedRoot
      && matchesTitle(expectedTitle, title)
      && !/的索引|未找到文件|Index of/i.test(title)
    if (!report.ok) report.reason = 'the webview did not load the embedded UI document'
    return report
  } finally {
    try {
      const cleanupDependencies = fixture?.tempDir
        ? { ...dependencies, operationRoot: () => path.join(fixture.tempDir, OPERATION_ROOT_NAME) }
        : dependencies
      report.cleanup = await cleanupProbeProcesses(cleanupDependencies, {
        roots,
        identity: fixture ? { sourceExe: fixture.exe, sourceSha256: fixture.sha256 } : null,
      })
    } catch (error) {
      report.cleanupError = error.message
    }
    if (fixture) {
      try {
        await dependencies.removeFixture(fixture.directory)
      } catch { /* the fixture is disposable; a locked file is not a probe failure */ }
    }
  }
}

module.exports = {
  probeNativeUi,
  isEmbeddedAppUrl,
  matchesTitle,
  readWebSocketFrame,
  encodeWebSocketFrame,
  normalizeWindowsPath,
  sameExecutablePath,
  sameProcessIdentity,
  parseProcessSnapshot,
  matchRelocatedBootstrap,
  discoverOwnedRelocations,
  selectOwnedProcesses,
  sha256File,
  prepareProbeFixture,
  buildProbeEnvironment,
  parseCommandLineArguments,
  cleanupProbeProcesses,
  createDefaultDependencies,
  DEFAULT_TITLE,
}

if (require.main === module) {
  let parsed = null
  try {
    parsed = parseCommandLineArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
  if (parsed && !parsed.exe) {
    console.error('Usage: node scripts/probe-native-ui.cjs <exe> [title-regex] [--uninstall] [--arg <value>]')
    process.exitCode = 1
  } else if (parsed) {
    const expectedTitle = parsed.title ? new RegExp(parsed.title) : DEFAULT_TITLE
    probeNativeUi(parsed.exe, { expectedTitle, args: parsed.appArgs })
      .then(report => {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
        // Exit 2 (not 1) marks "this host cannot run the image": the caller may treat
        // that as a skip, while 1 always means the page really was wrong.
        process.exitCode = report.ok ? 0 : report.unrunnable ? 2 : 1
      })
      .catch(error => { console.error(error.stack || error); process.exitCode = 1 })
  }
}
