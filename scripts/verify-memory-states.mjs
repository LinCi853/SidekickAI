import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { assessState, selectProcessTree } from './memory-state-contract.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index < 0 ? fallback : args[index + 1]
}
const state = option('state', 'standard')
const count = Number(option('samples', '10'))
const intervalMs = Number(option('interval-ms', '1000'))
const sustainSeconds = Number(option('sustain-seconds', '0'))
if (!Number.isInteger(sustainSeconds) || (sustainSeconds !== 0 && (sustainSeconds < 60 || sustainSeconds > 1800))) throw new Error('--sustain-seconds must be 0 or 60..1800')
const trimOnce = args.includes('--trim-once')
const lowMemoryMode = args.includes('--low-memory')
if (!['standard', 'minimum', 'browsers', 'shells'].includes(state)) throw new Error('Unknown --state')
if (!Number.isInteger(count) || count < 3 || count > 120) throw new Error('--samples must be 3..120')
if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 10000) throw new Error('--interval-ms must be 1000..10000')
if (process.platform !== 'win32') throw new Error('Windows total working-set verification is required')
const local = path.join(root, 'local')
await mkdir(local, { recursive: true })
const evidence = await mkdtemp(path.join(local, 'memory-states-'))
const bundle = path.join(root, 'out/main/index.cjs')
const report = {
  state, environment: 'built', metric: 'process-tree-total-working-set-including-shared-pages',
  diagnosticGpuBudgetMB: option('gpu-budget-mb', null), lowMemoryMode, units: 'MiB/GiB', capturedAt: new Date().toISOString(),
  samples: [], checks: [], toggleLatencyMs: [], pageErrors: [],
  workload: option('url', state === 'standard' ? 'production-default-startup' : 'local-interactive-fixture'),
}
let application
let server
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function inventory() {
  return application.evaluate(({ BrowserWindow, webContents, app }) => {
    const windows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed())
    const browserWindows = windows.filter(win => new URL(win.webContents.getURL() || 'about:blank').searchParams.get('mode') === 'browser')
    const pages = webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc.getType() === 'webview')
    return {
      windows: windows.length, browserWindows: browserWindows.length, guests: pages.length,
      browserGuests: pages.filter(wc => browserWindows.some(win => wc.hostWebContents === win.webContents)).length,
      readyBrowserWindows: browserWindows.filter(win => pages.some(wc => wc.hostWebContents === win.webContents && !wc.isLoading() && /^https?:/.test(wc.getURL()))).length,
      renderers: app.getAppMetrics().filter(metric => metric.type === 'Tab').length,
      windowDetails: windows.map(win => ({ id: win.id, url: win.webContents.getURL(), visible: win.isVisible(), minimized: win.isMinimized() })),
      webpages: pages.map(wc => ({ id: wc.id, url: wc.getURL(), loading: wc.isLoading() })),
      processRoles: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, name: metric.serviceName || metric.name })),
    }
  })
}

async function sample(phase = state === 'browsers' ? 'uniform-window-size' : 'ready-state') {
  const before = await inventory()
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,PageFaults,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  const rows = JSON.parse(result.stdout.trim() || '[]')
  const processes = selectProcessTree(Array.isArray(rows) ? rows : [rows], report.rootPid)
  for (const process of processes) { const row = rows.find(row => Number(row.ProcessId) === process.pid); process.commitBytes = Number(row.PrivatePageCount); process.pageFaults = Number(row.PageFaults) }
  const after = await inventory()
  if (JSON.stringify(before.windowDetails.map(win => win.id)) !== JSON.stringify(after.windowDetails.map(win => win.id))
    || JSON.stringify(before.webpages.map(page => page.id)) !== JSON.stringify(after.webpages.map(page => page.id))) {
    report.checks.push('Window or webpage inventory changed during process sampling')
  }
  const memoryDiagnostics = await application.evaluate(({ app }) => app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, memory: metric.memory })));
  const entry = { phase, memoryDiagnostics, capturedAt: new Date().toISOString(), processes, inventory: after, totalBytes: processes.reduce((sum, p) => sum + p.bytes, 0) }
  entry.residentMemory = await application.evaluate(({ app }) => app.__residentMemoryDiagnostics?.() ?? null)
  entry.totalCommitBytes = processes.reduce((sum, p) => sum + p.commitBytes, 0)
  report.samples.push(entry)
  console.log(state + ': ' + (entry.totalBytes / 1048576).toFixed(1) + ' MiB, windows=' + after.windows + ', webpages=' + after.guests)
}

try {
  report.bundleModifiedAt = (await stat(bundle)).mtime.toISOString()
  await writeFile(path.join(evidence, 'runner-source.mjs'), await readFile(fileURLToPath(import.meta.url)))
  const compiled = (await Promise.all(['out/main', 'out/preload', 'out/renderer'].map(async directory => (await readdir(path.join(root, directory), { recursive: true }))
    .filter(name => /\.(?:cjs|js|css|html)$/.test(name)).map(name => directory + '/' + name.replaceAll('\\', '/'))))).flat()
  report.build = Object.fromEntries(await Promise.all([...compiled, 'resources/windows/SidekickStartup.exe', 'resources/windows/startup-helper.json', 'scripts/verify-memory-states.mjs', 'scripts/memory-state-contract.mjs']
    .map(async relative => [relative, createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')])))
  report.gitHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  report.workingTree = (await execute('git', ['status', '--porcelain=v1'], { cwd: root })).stdout
  if (state === 'shells') {
    report.status = 'BLOCKED'
    report.checks.push('No production API currently creates ten non-browser main-shell instances; a synthetic BrowserWindow benchmark would not prove this requirement')
  } else {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Memory state fixture</title><textarea id="draft">persisted during warm toggle</textarea><button onclick="this.textContent=String(++window.clicks)">Count</button><script>window.clicks=0;window.sessionToken=crypto.randomUUID()</script>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const fixtureUrl = 'http://127.0.0.1:' + server.address().port + '/'; const url = option('url', null) === 'fixture' ? fixtureUrl : option('url', fixtureUrl)
    if (!/^https?:\/\//.test(url)) throw new Error('--url must be an HTTP(S) page')
    const bootstrap = path.join(evidence, 'bootstrap.cjs')
    await writeFile(bootstrap, [
      "const { app, globalShortcut } = require('electron');",
      'app.setAppPath(' + JSON.stringify(root) + ');',
      'app.setLoginItemSettings = () => {};',
      'app.relaunch = () => { throw new Error("Unexpected test relaunch"); };',
      'global.__memoryShortcutCallbacks = new Map();',
      'const register = globalShortcut.register.bind(globalShortcut);',
      'globalShortcut.register = (accelerator, callback) => { const result = register(accelerator, callback); if (result) global.__memoryShortcutCallbacks.set(accelerator, callback); return result; };',
      'require(' + JSON.stringify(bundle) + ');',
      ...(option('gpu-budget-mb', null) ? ['app.commandLine.appendSwitch("force-gpu-mem-available-mb", ' + JSON.stringify(option('gpu-budget-mb', null)) + ');'] : []),
    ].join('\n'))
    const env = { ...process.env, SIDEKICK_DATA_DIR: path.join(evidence, 'profile'), SIDEKICK_TEST_SESSION: evidence }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LIB', 'LIBPATH']) delete env[key]
    application = await electron.launch({ executablePath: require('electron'), args: [bootstrap, '--skip-guide'], cwd: root, env, timeout: 60000 })
    report.rootPid = await application.evaluate(({ app }) => app.getAppMetrics().find(metric => metric.type === 'Browser').pid)
    application.on('window', page => page.on('pageerror', error => report.pageErrors.push(error.message)))
    const main = await application.firstWindow()
    await main.waitForFunction(() => window.electron && document.body.innerText.length > 50)
    await main.evaluate(enabled => window.electron.appSettings.update({ lowMemoryMode: enabled }), lowMemoryMode)
    const mountDeadline = Date.now() + 30000;
    while (!(await inventory()).guests) { if (Date.now() > mountDeadline) throw new Error('Main webpage did not mount'); await pause(100); }
    if (state !== 'standard' || option('url', null)) await application.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview')
      if (!guest) throw new Error('Main webpage did not mount')
      await guest.loadURL(url)
    }, url)
    if (state === 'browsers') await main.evaluate(async () => {
      const api = window.electron
      const result = await api.modules.setEnabled('browser', true)
      if (!result.ok) throw new Error(result.error)
    })
    if (state === 'standard') {
      await pause(1000)
      for (let i = 0; i < count; i += 1) {
        await sample()
        if (i + 1 < count) await pause(intervalMs)
      }
      report.startupSamples = report.samples.length
      report.rendererResources = await main.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name))
    }
    if (state === 'standard') await main.evaluate(() => window.electron.hotkey.set('toggleMainWindow', 'Control+Alt+Shift+F12'))
    const shortcut = await main.evaluate(async () => (await window.electron.hotkey.getAll()).find(key => key.action === 'toggleMainWindow'))
    if (state === 'standard' && !shortcut?.enabled) throw new Error('Main window shortcut is disabled')
    if (state === 'standard') await application.evaluate((_, accelerator) => {
      if (!global.__memoryShortcutCallbacks.has(accelerator)) throw new Error('Main window shortcut is not registered; close conflicting application before testing')
    }, shortcut.accelerator)

    if (state === 'browsers') {
      for (let i = 0; i < 10; i += 1) {
        await main.evaluate(async ({ index, url }) => {
          const api = window.electron
          const profile = await api.profile.create({ name: 'Memory fixture ' + index, isAIPlatform: true, aiPlatformUrl: url, browserHomePage: url })
          const state = await api.windowState.get('main') ?? { windowId: 'main', bounds: { width: 420, height: 820 }, isMaximized: false, alwaysOnTop: false, activeTabId: null, tabs: [], bottomBarExpanded: false }
          const tab = { id: crypto.randomUUID(), profileId: profile.id, title: profile.name, order: state.tabs.length, url }
          await api.windowState.save('main', { ...state, tabs: [...state.tabs, tab] })
          await api.windowControl.detachTab(tab.id)
        }, { index: i, url })
        const expectedCount = i + 1
        const deadline = Date.now() + 30000
        while ((await inventory()).readyBrowserWindows < expectedCount) {
          if (Date.now() >= deadline) throw new Error('Browser page did not become ready: ' + expectedCount)
          await pause(200)
        }
      }
      // The production default is maximized. Capture it before any benchmark
      // resizing so a large compositor allocation cannot disappear unmeasured.
      for (let i = 0; i < count; i += 1) {
        await sample('production-default-maximized')
        if (i + 1 < count) await pause(intervalMs)
      }
      await application.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (new URL(win.webContents.getURL() || 'about:blank').searchParams.get('mode') !== 'browser') continue
          win.unmaximize()
          win.setBounds({ width: 900, height: 650 })
        }
      })
      const deadline = Date.now() + 60000
      while ((await inventory()).readyBrowserWindows !== 10) {
        if (Date.now() >= deadline) throw new Error('Ten browser pages did not finish loading')
        await pause(500)
      }
    } else if (state === 'minimum') {
      await application.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) win.hide()
      })
    } else {
      const guestBefore = await application.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview')
        return { id: guest.id, token: await guest.executeJavaScript('window.__memoryGuestToken = crypto.randomUUID()') }
      })
      const token = await main.evaluate(() => { window.__memoryWarmToken = crypto.randomUUID(); return window.__memoryWarmToken })
      for (let i = 0; i < 5; i += 1) {
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
        await pause(1600)
        const started = Date.now()
        await application.evaluate((_, accelerator) => global.__memoryShortcutCallbacks.get(accelerator)(), shortcut.accelerator)
        await main.waitForFunction(expected => window.__memoryWarmToken === expected && document.visibilityState === 'visible', token, { timeout: 5000 })
        report.toggleLatencyMs.push(Date.now() - started)
      }
      if (await main.evaluate(() => window.__memoryWarmToken) !== token) report.checks.push('Main renderer reloaded during toggle')
      const guestAfter = await application.evaluate(async ({ webContents }) => {
        const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview')
        return guest ? { id: guest.id, token: await guest.executeJavaScript('window.__memoryGuestToken') } : null
      })
      if (JSON.stringify(guestBefore) !== JSON.stringify(guestAfter)) report.checks.push('Main webpage was destroyed or reloaded during warm toggles')
      if (report.toggleLatencyMs.some(ms => ms > 200)) report.checks.push('Warm shortcut callback to visible renderer exceeded proposed 200 ms target')
      report.shortcutTest = 'registered callback dispatch; physical keyboard routing and perceived first-frame latency require separate desktop acceptance'
    }
    await pause(3000)
    for (let i = 0; i < count; i += 1) {
      await sample()
      if (i + 1 < count) await pause(intervalMs)
    }
    if (sustainSeconds && state === "standard") {
      const start = Date.now()
      const startIndex = report.samples.length
      const identities = (await inventory()).webpages.map(page => page.id)
      report.sustainedInteractionLatencyMs = []
      report.sustainedWakeLatencyMs = []
      while (Date.now() - start < sustainSeconds * 1000) {
        await pause(Math.min(22000, sustainSeconds * 1000 - (Date.now() - start)))
        await sample()
        const inputStarted = Date.now()
        await application.evaluate(async ({ webContents }) => {
          const guest = webContents.getAllWebContents().find(wc => wc.getType() === "webview")
          if (!guest) throw new Error("Main guest disappeared during sustained use")
          guest.sendInputEvent({ type: "mouseWheel", x: 200, y: 200, deltaY: 100, deltaX: 0, canScroll: true })
          await Promise.race([guest.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"), new Promise((_, reject) => setTimeout(() => reject(new Error("Guest did not draw within 2 seconds")), 2000))])
        })
        report.sustainedInteractionLatencyMs.push(Date.now() - inputStarted)
        await application.evaluate((_, accelerator) => global.__memoryShortcutCallbacks.get(accelerator)(), shortcut.accelerator)
        await pause(100)
        const wakeStarted = Date.now()
        await application.evaluate((_, accelerator) => global.__memoryShortcutCallbacks.get(accelerator)(), shortcut.accelerator)
        await main.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 2000 })
        await main.screenshot({ timeout: 2000, animations: "disabled" })
        report.sustainedWakeLatencyMs.push(Date.now() - wakeStarted)
        await sample()
        if (JSON.stringify((await inventory()).webpages.map(page => page.id)) !== JSON.stringify(identities)) report.checks.push("Guest identity changed during sustained use")
      }
      const steady = report.samples.slice(startIndex)
      report.sustained = { seconds: (Date.now() - start) / 1000, sampleCount: steady.length, minBytes: Math.min(...steady.map(s => s.totalBytes)), maxBytes: Math.max(...steady.map(s => s.totalBytes)), maxCommitBytes: Math.max(...steady.map(s => s.totalCommitBytes)), faultsMetric: "Generic process PageFaults include soft faults and do not measure disk hard faults" }
      if (report.sustainedWakeLatencyMs.some(ms => ms > 200)) report.checks.push("Sustained warm wake exceeded 200 ms")
    }
    if (sustainSeconds && state === 'browsers') {
      const start = Date.now(), startIndex = report.samples.length
      const identities = await application.evaluate(async ({ BrowserWindow, webContents }) => {
        const windows = BrowserWindow.getAllWindows().filter(win => new URL(win.webContents.getURL() || 'about:blank').searchParams.get('mode') === 'browser')
        return Promise.all(windows.map(async win => {
          const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview' && wc.hostWebContents === win.webContents)
          if (!guest || guest.isLoading()) throw new Error('Browser webpage is not ready')
          const token = 'window.__memorySustainToken = crypto.randomUUID()'
          return { windowId: win.id, guestId: guest.id, shellToken: await win.webContents.executeJavaScript(token), guestToken: await guest.executeJavaScript(token) }
        }))
      })
      if (identities.length !== 10) throw new Error('Ten browsers required for sustained checks')
      report.browserInteractions = []
      let nextInteraction = start + 45000
      while (Date.now() - start < sustainSeconds * 1000) {
        await pause(Math.min(10000, Math.max(0, start + sustainSeconds * 1000 - Date.now())))
        await sample()
        if (Date.now() < nextInteraction) continue
        nextInteraction = Date.now() + 45000
        const interactions = await application.evaluate(async ({ BrowserWindow, webContents }, identities) => {
          const results = []
          for (const identity of identities) {
            const win = BrowserWindow.fromId(identity.windowId), guest = webContents.fromId(identity.guestId)
            if (!win || win.isDestroyed() || !guest || guest.isDestroyed()) throw new Error('Browser or webpage disappeared during sustained use')
            const started = Date.now()
            win.show(); win.focus()
            guest.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: 100, deltaX: 0, canScroll: true })
            const frameScript = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ visibility: document.visibilityState, token: window.__memorySustainToken }))))'
            let timer, frames
            try {
              frames = await Promise.race([
                Promise.all([win.webContents.executeJavaScript(frameScript), guest.executeJavaScript(frameScript)]),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser did not deliver visible frames within 2 seconds')), 2000) }),
              ])
            } finally { clearTimeout(timer) }
            if (frames.some(frame => frame.visibility !== 'visible') || frames[0].token !== identity.shellToken || frames[1].token !== identity.guestToken) throw new Error('Browser was reloaded or remained hidden')
            results.push({ ...identity, at: Date.now(), frameMs: Date.now() - started })
          }
          return results
        }, identities)
        report.browserInteractions.push(...interactions)
        await sample()
      }
      const steady = report.samples.slice(startIndex)
      report.sustained = { seconds: (Date.now() - start) / 1000, sampleCount: steady.length, minBytes: Math.min(...steady.map(s => s.totalBytes)), maxBytes: Math.max(...steady.map(s => s.totalBytes)), maxCommitBytes: Math.max(...steady.map(s => s.totalCommitBytes)), browserIdentities: identities }
    }
    if (trimOnce) {
      report.experiment = 'one-time target-tree working-set trim; production acceptance still includes untrimmed startup';
      const pids = report.samples.at(-1).processes.map(process => process.pid);
      const trimScript = [
        '$ErrorActionPreference="Stop"',
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WorkingSetExperiment { [DllImport(\"psapi.dll\", SetLastError=true)] public static extern bool EmptyWorkingSet(IntPtr process); }'",
        ...pids.map(pid => '$p=Get-Process -Id '+pid+'; if (-not [WorkingSetExperiment]::EmptyWorkingSet($p.Handle)) { throw "Working-set trim failed" }'),
      ].join('; ');
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', trimScript], { timeout: 30000 });
      report.trimmedAt = new Date().toISOString();
      report.untrimmedSampleCount = report.samples.length;
      report.interactionLatencyMs = [];
      for (let i = 0; i < count; i += 1) {
        await sample();
        const started = Date.now();
        await main.evaluate(() => { window.dispatchEvent(new Event('resize')); document.body.scrollTop = 10; });
        await application.evaluate(async ({ webContents }) => { const guest = webContents.getAllWebContents().find(wc => wc.getType() === 'webview'); if (guest) await guest.executeJavaScript('window.scrollBy(0,100); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); });
        report.interactionLatencyMs.push(Date.now() - started);
        if (i + 1 < count) await pause(intervalMs);
      }
    }
    if (report.pageErrors.length) report.checks.push('Renderer page errors occurred')
    Object.assign(report, assessState(state, report.samples, report.checks))
  }
} catch (error) {
  report.status = 'ERROR'
  report.error = error.stack
  if (application) {
    try { report.lastInventory = await inventory(); report.lastPages = await Promise.all(application.windows().map(async page => ({ url: page.url(), text: (await page.locator('body').innerText()).slice(0,2000) }))) }
    catch (diagnosticError) { report.diagnosticError = diagnosticError.message }
  }
} finally {
  if (application) {
    try { await application.close() } catch (error) { report.status = 'ERROR'; report.closeError = error.stack }
  }
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Report: ' + path.join(evidence, 'report.json'))
  console.log('Result: ' + report.status)
}
process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 2 : 1
