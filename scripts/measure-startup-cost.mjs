// 同一编译产物下逐层拆解成本；结果仅为就绪后采样，不能冒充启动瞬时峰值。
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { selectProcessTree } from './memory-state-contract.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
if (process.platform !== 'win32') throw new Error('Windows required')
const modes = process.argv.slice(2)
const sampleIndex = modes.indexOf('--samples')
const sampleCount = sampleIndex < 0 ? 5 : Number(modes.splice(sampleIndex, 2)[1])
if (!Number.isInteger(sampleCount) || sampleCount < 5 || sampleCount > 15) throw new Error('--samples must be an integer from 5 to 15')
const cycleIndex = modes.indexOf('--help-cycle')
const helpCycle = cycleIndex >= 0
if (helpCycle) modes.splice(cycleIndex, 1)
const styleIndex = modes.indexOf('--style-experiment')
const styleExperiment = styleIndex < 0 ? null : modes.splice(styleIndex, 2)[1]
if (styleIndex >= 0 && !['legacy-shortcuts', 'closed-panels', 'drawer-only', 'shortcuts-only', 'closed-visibility', 'no-effects', 'no-paint'].includes(styleExperiment)) throw new Error('Unknown style experiment')
if (!modes.length) modes.push('engine', 'window', 'window-preload', 'product-services', 'product-shell', 'product-page')
if (modes.some(mode => !['engine', 'window', 'window-preload', 'product-services', 'product-shell', 'product-page'].includes(mode))) throw new Error('Unknown diagnostic mode')
if (helpCycle && modes.some(mode => !['product-shell', 'product-page'].includes(mode))) throw new Error('Help cycle requires the product UI')
const evidence = await mkdtemp(path.join(root, 'local/startup-cost-'))
const files = (await Promise.all(['out/main', 'out/preload', 'out/renderer'].map(async directory => (await readdir(path.join(root, directory), { recursive: true })).filter(name => /\.(?:cjs|js|css|html)$/.test(name)).map(name => directory + '/' + name.replaceAll('\\', '/'))))).flat()
files.push('scripts/startup-cost-fixture.cjs', 'scripts/measure-startup-cost.mjs', 'electron/main.ts', 'resources/windows/SidekickStartup.exe')
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])))
const command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
const processes = async () => { const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 }); const rows = JSON.parse(result.stdout); return Array.isArray(rows) ? rows : [rows] }
const report = { capturedAt: new Date().toISOString(), evidence, diagnosticOnly: true, physicalHotkeysStubbed: true, reclaimEnabled: false,
  styleExperiment, helpCycle, sampleCount, metric: 'process-tree-total-working-set-including-shared-pages', sampling: sampleCount + ' post-ready samples spaced two seconds apart; excludes unobserved startup peaks', build: await hashes(), groups: [] }
for (const file of ['startup-cost-fixture.cjs', 'measure-startup-cost.mjs']) await writeFile(path.join(evidence, file), await readFile(path.join(root, 'scripts', file)))
console.log(evidence)
try {
  for (const mode of modes) {
    const directory = path.join(evidence, mode)
    await mkdir(path.join(directory, 'profile'), { recursive: true })
    const telemetry = path.join(directory, 'telemetry.json')
    const log = await open(path.join(directory, 'runtime.log'), 'w')
    const env = { ...process.env, SIDEKICK_DATA_DIR: path.join(directory, 'profile'), SIDEKICK_TEST_SESSION: directory,
      SIDEKICK_RESIDENT_RECLAIM: '0', SIDEKICK_STARTUP_COST_MODE: mode, SIDEKICK_STARTUP_COST_TELEMETRY: telemetry }
    if (styleExperiment) env.SIDEKICK_STARTUP_COST_STYLE = styleExperiment
    else delete env.SIDEKICK_STARTUP_COST_STYLE
    env.SIDEKICK_STARTUP_COST_HELP_CYCLE = helpCycle ? '1' : '0'
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'SIDEKICK_MEMORY_EVIDENCE']) delete env[key]
    const child = spawn(require('electron'), [path.join(root, 'scripts/startup-cost-fixture.cjs'), '--skip-guide'], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] })
    const group = { mode, samples: [], errors: [] }
    report.groups.push(group)
    let exited = false, exitCode, rootCreatedAt
    const ended = new Promise(resolve => { child.on('error', error => { group.errors.push(String(error)); exited = true; resolve() }); child.on('exit', code => { exited = true; exitCode = code; resolve() }) })
    const readTelemetry = () => readFile(telemetry, 'utf8').then(JSON.parse).catch(() => null)
    try {
      const deadline = Date.now() + 35000
      let data
      while (!exited && Date.now() < deadline) { data = await readTelemetry(); if (data?.readyAt) break; await pause(100) }
      if (exited || !data?.readyAt) throw new Error('Fixture did not become ready')
      group.rootPid = data.pid
      group.readyMs = data.readyAt - data.startedAt
      for (let index = 0; index < sampleCount; index++) {
        await pause(2000)
        const before = await readTelemetry()
        if (!before || before.closingAt || exited) throw new Error('Fixture closed before sampling')
        const rows = await processes()
        const after = await readTelemetry()
        if (!after || after.closingAt || exited) throw new Error('Fixture closed during sampling')
        if (JSON.stringify(before.windows.map(win => win.id)) !== JSON.stringify(after.windows.map(win => win.id)) || JSON.stringify(before.guests.map(guest => guest.id)) !== JSON.stringify(after.guests.map(guest => guest.id))) throw new Error('Window or guest changed during sampling')
        const main = rows.find(row => Number(row.ProcessId) === data.pid)
        if (!main) throw new Error('Root process is missing')
        rootCreatedAt ??= main.CreatedAt
        if (main.CreatedAt !== rootCreatedAt) throw new Error('Root PID was reused')
        const tree = selectProcessTree(rows, data.pid).map(process => {
          const row = rows.find(row => Number(row.ProcessId) === process.pid)
          const metric = after.metrics.find(metric => metric.pid === process.pid)
          if (row.PrivatePageCount == null || !Number.isFinite(Number(row.PrivatePageCount))) throw new Error('Private commit counter is missing')
          return { ...process, createdAt: row.CreatedAt, commitBytes: Number(row.PrivatePageCount), type: metric?.type ?? process.name }
        })
        if (after.metrics.some(metric => !tree.some(process => process.pid === metric.pid))) throw new Error('Process tree omitted a live Electron process')
        group.samples.push({ at: Date.now(), readyAgeMs: Date.now() - data.readyAt, totalBytes: tree.reduce((sum, process) => sum + process.bytes, 0),
          totalCommitBytes: tree.reduce((sum, process) => sum + process.commitBytes, 0), processes: tree, telemetry: after })
      }
      const finalTelemetry = await readTelemetry()
      group.errors.push(...finalTelemetry.errors)
      if (mode === 'product-services' && finalTelemetry.replacedShells !== 1) group.errors.push('Expected exactly one diagnostic main-shell substitution')
      if (helpCycle && !finalTelemetry.helpCycleCompletedAt) group.errors.push('Help cycle did not complete')
    } catch (error) { group.errors.push(String(error)) }
    finally {
      if (!exited) await writeFile(telemetry + '.stop', '')
      let exitTimer
      try { await Promise.race([ended, new Promise(resolve => { exitTimer = setTimeout(resolve, 10000) })]) }
      finally { clearTimeout(exitTimer) }
      if (!exited) { group.errors.push('Fixture did not exit after stop'); child.kill(); await ended }
      group.exitCode = exitCode
      if (exitCode !== 0) group.errors.push('Fixture exit code: ' + exitCode)
      await pause(500)
      const remaining = await processes()
      const identities = [...new Map(group.samples.flatMap(sample => sample.processes).map(process => [process.pid + ':' + process.createdAt, process])).values()]
      group.residuals = identities.filter(process => remaining.some(row => Number(row.ProcessId) === process.pid && row.CreatedAt === process.createdAt))
      if (group.residuals.length) group.errors.push('Verified fixture processes remain after exit')
      await log.close()
    }
    if (group.samples.length) {
      const values = group.samples.map(sample => sample.totalBytes / 1048576).sort((a, b) => a - b)
      group.summary = { minMiB: values[0], medianMiB: values[Math.floor(values.length / 2)], maxMiB: values.at(-1), lastCommitMiB: group.samples.at(-1).totalCommitBytes / 1048576,
        lastRoles: group.samples.at(-1).processes.map(process => ({ type: process.type, MiB: process.bytes / 1048576, commitMiB: process.commitBytes / 1048576 })) }
    }
    console.log(JSON.stringify({ mode, summary: group.summary, errors: group.errors }))
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    if (group.errors.length) throw new Error('Diagnostic group failed: ' + mode)
  }
  report.buildUnchanged = JSON.stringify(await hashes()) === JSON.stringify(report.build)
  if (!report.buildUnchanged) throw new Error('Build changed during measurement')
  report.status = 'MEASURED'
} catch (error) { report.status = 'ERROR'; report.error = String(error); process.exitCode = 1 }
await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
