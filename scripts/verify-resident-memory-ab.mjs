import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessState, selectProcessTree } from './memory-state-contract.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url), execute = promisify(execFile)
const seconds = Number(process.argv[2] || 300)
const functional = process.argv.includes('--functional')
const reclaimFlow = process.argv.includes('--reclaim-flow')
const gpuDiagnostics = process.argv.includes('--gpu-diagnostics')
const gpuCacheIndex = process.argv.indexOf('--gpu-cache-kib')
const gpuCacheKiB = gpuCacheIndex < 0 ? null : Number(process.argv[gpuCacheIndex + 1])
if (gpuCacheKiB !== null && (!gpuDiagnostics || !Number.isInteger(gpuCacheKiB) || gpuCacheKiB < 128 || gpuCacheKiB > 16384)) throw new Error('--gpu-cache-kib requires --gpu-diagnostics and 128..16384 KiB')
const angleIndex = process.argv.indexOf('--gpu-angle')
const gpuAngle = angleIndex < 0 ? null : process.argv[angleIndex + 1]
if (gpuAngle !== null && (!gpuDiagnostics || !['d3d11', 'gl', 'd3d11on12'].includes(gpuAngle))) throw new Error('--gpu-angle requires --gpu-diagnostics and d3d11, gl or d3d11on12')
const enabledOnly = process.argv.includes('--enabled-only')
const browsers = process.argv.includes('--browsers')
const loadingPeer = process.argv.includes('--loading-peer')
if (loadingPeer && !browsers) throw new Error('--loading-peer requires --browsers')
const activeInput = process.argv.includes('--active-input')
if (activeInput && !browsers) throw new Error('--active-input requires --browsers')
if (reclaimFlow && (!functional || browsers || !enabledOnly || seconds < 40)) throw new Error('--reclaim-flow requires --functional --enabled-only, a single window, and at least 40 seconds')
const tracePaint = process.argv.includes('--trace-paint')
if (!Number.isInteger(seconds) || seconds < (functional ? 20 : 120) || seconds > 1800) throw new Error('Duration must be 120..1800 seconds per group, or 20..1800 with --functional')
if (process.platform !== 'win32') throw new Error('Windows required')
const evidence = await mkdtemp(path.join(root, 'local/resident-ab-'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { evidence, capturedAt: new Date().toISOString(), secondsPerGroup: seconds, enabledOnly, functional, capacityDiagnosticOnly: functional, workload: 'production-default-startup', shortcutTest: 'callback dispatch plus renderer and webpage roundtrip; physical keyboard and first-frame latency require separate acceptance', metric: 'process-tree-total-working-set-including-shared-pages', units: 'MiB', groups: [] }
report.activeInput = activeInput
report.loadingPeer = loadingPeer
report.reclaimFlow = reclaimFlow
report.gpuExperiment = gpuDiagnostics ? { diagnostic: true, programCacheKiB: gpuCacheKiB, angle: gpuAngle } : undefined
if (browsers) {
 report.workload = 'ten-production-browser-windows-plus-retained-main-local-interactive-fixture'
 report.shortcutTest = 'production detach IPC; native window show/focus, wheel input, retained drafts and shell/guest double-rAF; no CDP or physical-keyboard claim'
}
const compiled = (await Promise.all(['out/main', 'out/preload', 'out/renderer'].map(async directory => (await readdir(path.join(root,directory), { recursive: true })).filter(name => /\.(?:cjs|js|css|html)$/.test(name)).map(name => directory + '/' + name.replaceAll('\\','/'))))).flat()
report.build = Object.fromEntries(await Promise.all([...compiled, 'resources/windows/SidekickStartup.exe', 'build/native-startup/SidekickStartup.exe', 'scripts/resident-memory-fixture.cjs', 'scripts/resident-browser-fixture.cjs', 'scripts/verify-resident-memory-ab.mjs'].map(async relative => [relative, await readFile(path.join(root,relative)).then(bytes=>createHash('sha256').update(bytes).digest('hex')).catch(()=>null)])))
for (const file of ['verify-resident-memory-ab.mjs', browsers ? 'resident-browser-fixture.cjs' : 'resident-memory-fixture.cjs']) await writeFile(path.join(evidence, file), await readFile(path.join(root, 'scripts', file)))
const percentile = (values, fraction) => { const ordered = [...values].sort((a,b) => a-b); return ordered[Math.max(0,Math.ceil(ordered.length*fraction)-1)] }
const command = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,PageFaults,@{Name='CreatedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
console.log(evidence)
try {
 for (const enabled of enabledOnly ? [true] : [false, true]) {
  const directory = path.join(evidence, enabled ? 'enabled' : 'disabled'); await mkdir(directory)
  const telemetry = path.join(directory, 'telemetry.json')
  const log = await open(path.join(directory, 'runtime.log'), 'w')
  const env = { ...process.env, SIDEKICK_DATA_DIR: path.join(directory, 'profile'), SIDEKICK_TEST_SESSION: directory, SIDEKICK_RESIDENT_RECLAIM: enabled ? '1' : '0', SIDEKICK_MEMORY_EVIDENCE: telemetry, SIDEKICK_MEMORY_DURATION: String(seconds * 1000), SIDEKICK_MEMORY_ACTIVE_INPUT: activeInput ? '1' : '0' }
  env.SIDEKICK_MEMORY_LOADING_PEER = loadingPeer ? '1' : '0'
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LIB', 'LIBPATH']) delete env[key]
  for (const key of ['SIDEKICK_MEMORY_PAINT_ACTION', 'SIDEKICK_MEMORY_FORCE_RESTORE', 'SIDEKICK_MEMORY_HIDE_ONLY', 'SIDEKICK_MEMORY_TRACE_PAINT', 'SIDEKICK_MEMORY_CAPTURE_FAILURE', 'SIDEKICK_MEMORY_INTERACTION_MS', 'SIDEKICK_MEMORY_RESIZE_MS', 'SIDEKICK_MEMORY_FOREGROUND_DRAWING', 'SIDEKICK_MEMORY_RECLAIM_FLOW', 'SIDEKICK_MEMORY_GPU_DIAGNOSTICS']) delete env[key]
  if (functional) {
   // Background renderers need a real idle opportunity before a full input
   // round touches all ten windows. The single-window smoke test stays faster.
   env.SIDEKICK_MEMORY_INTERACTION_MS = String(browsers ? Math.max(25000, Math.floor(seconds * 1000 / 2)) : Math.max(4000, Math.floor(seconds * 1000 / 4)))
   if (browsers) env.SIDEKICK_MEMORY_RESIZE_MS = String(Math.floor(seconds * 1000 * 0.75))
  }
  if (reclaimFlow) env.SIDEKICK_MEMORY_RECLAIM_FLOW = '1'
  if (gpuDiagnostics) env.SIDEKICK_MEMORY_GPU_DIAGNOSTICS = '1'
  if (tracePaint) env.SIDEKICK_MEMORY_TRACE_PAINT = '1'
  const fixture = browsers ? path.join(root, 'scripts/resident-browser-fixture.cjs') : path.join(root, 'scripts/resident-memory-fixture.cjs')
  const child = spawn(require('electron'), [fixture, '--skip-guide', ...(gpuCacheKiB === null ? [] : ['--gpu-program-cache-size-kb=' + gpuCacheKiB]), ...(gpuAngle === null ? [] : ['--use-angle=' + gpuAngle])], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] })
  let ended = false, code, failure
  child.on('error', error => { failure = String(error); ended = true })
  child.on('exit', value => { code = value; ended = true })
  const group = { enabled, samples: [], discardedSamples: [] }; report.groups.push(group)
  let rootPid, rootCreatedAt
  const deadline = Date.now() + (seconds + (browsers ? 120 : 60)) * 1000
  while (!ended && Date.now() < deadline) {
   await pause(functional ? 1000 : 10000)
   if (ended) break
   let data; try { data = JSON.parse(await readFile(telemetry, 'utf8')) } catch { continue }
   const main = data.observations.at(-1)?.metrics.find(m => m.type === 'Browser')
   if (!main) continue
   if (browsers && data.observations.at(-1).phase === 'constructing') continue
   rootPid ??= main.pid
   const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
   if (ended) break
   let after
   try { after = JSON.parse(await readFile(telemetry, 'utf8')) } catch { group.discardedSamples.push({ at: Date.now(), reason: 'Telemetry changed during process sampling' }); continue }
   // CIM may finish while the fixture is already closing its renderers. Never
   // pair that smaller process tree with the previous ready-window inventory.
   if (after.closingAt) {
    group.discardedSamples.push({ at: Date.now(), reason: 'Fixture teardown started', closingAt: after.closingAt })
    const exitDeadline = Date.now() + 10000
    while (!ended && Date.now() < exitDeadline) await pause(100)
    break
   }
   const parsed = JSON.parse(result.stdout.trim() || '[]'), rows = Array.isArray(parsed) ? parsed : [parsed]
   const mainRow = rows.find(row => Number(row.ProcessId) === rootPid)
   if (!mainRow) { if (ended) break; throw new Error('Root exited during sampling') }
   rootCreatedAt ??= mainRow.CreatedAt
   if (mainRow.CreatedAt !== rootCreatedAt) throw new Error('Root PID was reused')
   const processes = selectProcessTree(rows, rootPid)
   const observation = data.observations.at(-1), next = after.observations.at(-1)
   if (observation.phase !== next.phase || JSON.stringify(observation.inventory) !== JSON.stringify(next.inventory)) {
    group.discardedSamples.push({ at: Date.now(), reason: 'Window inventory or phase changed during process sampling' }); continue
   }
   const missing = observation.metrics.filter(metric => !processes.some(process => process.pid === metric.pid))
   if (missing.length) throw new Error('Process sample omitted live application metrics: ' + missing.map(metric => metric.pid).join(', '))
   for (const process of processes) {
    const row = rows.find(row => Number(row.ProcessId) === process.pid)
    process.createdAt = row.CreatedAt
    process.commitBytes = Number(row.PrivatePageCount); process.pageFaults = Number(row.PageFaults)
    if (![process.commitBytes,process.pageFaults].every(Number.isFinite)) throw new Error('Missing process memory counters')
   }
   group.samples.push({ at: Date.now(), totalBytes: processes.reduce((sum,p) => sum+p.bytes,0), totalCommitBytes: processes.reduce((sum,p) => sum+p.commitBytes,0), processes, inventory: observation.inventory, ...(browsers ? { phase: observation.phase } : {}) })
   await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report,null,2))
  }
  if (!ended) { child.kill(); throw new Error('Fixture did not exit within its measurement/teardown deadline') }
  await log.close()
  group.telemetry = JSON.parse(await readFile(telemetry,'utf8'))
  if (failure || code !== 0 || group.telemetry.failure) throw new Error(failure || group.telemetry.failure || 'Fixture exited with code '+code)
  group.rootPid = rootPid
  group.errors = group.telemetry.interactions.filter(i => i.error || (!browsers && !i.hidden) || !i.visible)
  if (reclaimFlow && group.telemetry.flow?.phase !== 'complete') group.errors.push({ error: 'Idle reclaim and resume flow did not complete', flow: group.telemetry.flow })
  const sampledProcesses = [...new Map(group.samples.flatMap(sample => sample.processes.map(process => [process.pid + ':' + process.createdAt, process]))).values()]
  const auditResult = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
  const auditParsed = JSON.parse(auditResult.stdout.trim() || '[]'), auditRows = Array.isArray(auditParsed) ? auditParsed : [auditParsed]
  group.processAudit = { conhostSamples: group.samples.filter(sample => sample.processes.some(process => /^conhost\.exe$/i.test(process.name))).length,
   helperSamples: group.samples.filter(sample => sample.processes.some(process => /^SidekickStartup\.exe$/i.test(process.name))).length,
   checkedIdentities: sampledProcesses.length,
   residuals: sampledProcesses.filter(process => auditRows.some(row => Number(row.ProcessId) === process.pid && row.CreatedAt === process.createdAt)) }
  if (group.processAudit.residuals.length) group.errors.push({ error: 'Sampled application processes remain after fixture exit', residuals: group.processAudit.residuals })
  if (browsers && group.telemetry.observations.some(o => o.resident?.samples?.some(s => s.protection?.contents?.some(c => c.captured)))) group.errors.push({ error: 'Unexpected capture protection in the no-debugger browser fixture' })
  if (browsers) {
   const ready = group.samples.filter(sample => sample.phase !== 'constructing' && sample.inventory?.readyBrowserWindows === 10)
   group.capacity = assessState('browsers', ready, group.errors.map(error => error.error))
   group.phases = Object.fromEntries([...new Set(ready.map(sample => sample.phase))].map(phase => {
    const samples = ready.filter(sample => sample.phase === phase), values = samples.map(sample => sample.totalBytes / 1048576)
    return [phase, { samples: samples.length, minMiB: Math.min(...values), maxMiB: Math.max(...values), medianMiB: percentile(values, 0.5) }]
   }))
  } else {
   group.capacity = assessState('standard', group.samples, group.errors.map(error => error.error))
  }
  const values = group.samples.map(s => s.totalBytes / 1048576)
  const tail = values.slice(Math.floor(values.length/2))
  const actions = [...new Map(group.telemetry.observations.flatMap(o=>o.resident?.actions??[]).map(a=>[a.at+':'+a.candidate.pid,a])).values()]
  if (loadingPeer) {
   const peer = group.telemetry.loadingPeer
   group.loadingPeer = peer
   if (!peer || peer.loadingSamples < 5 || peer.loadingSamples !== peer.samples || !peer.completed) group.errors.push({ error: 'Loading peer was not continuously loading or did not finish in the same webContents' })
   const types = new Map(group.telemetry.observations.flatMap(observation => observation.metrics.map(metric => [metric.pid, metric.type])))
   if (enabled && !actions.some(action => action.result)) group.errors.push({ error: 'A loading peer prevented all background renderer reclaim' })
   if (enabled && (!peer?.quietSibling?.retained || !actions.some(action => action.result && action.candidate.pid === peer.quietSibling.pid))) group.errors.push({ error: 'The independent guest beside a loading tab was not reclaimed and resumed with its draft' })
   if (actions.some(action => action.result && (types.get(action.candidate.pid) !== 'Tab' || [peer?.shellPid, peer?.guestPid].includes(action.candidate.pid)))) group.errors.push({ error: 'A shared process or loading window renderer was reclaimed' })
  }
  if (activeInput) {
   const input = group.telemetry.activeInput
   if (!input || input.pulses < seconds / 2 || input.focusedPulses < seconds / 2 || input.acknowledgements < seconds / 2) group.errors.push({ error: 'Continuous foreground input was not acknowledged' })
   if (enabled && !actions.some(action => action.result)) group.errors.push({ error: 'No background renderer was reclaimed during continuous foreground input' })
   const types = new Map(group.telemetry.observations.flatMap(observation => observation.metrics.map(metric => [metric.pid, metric.type])))
   if (actions.some(action => action.result && (types.get(action.candidate.pid) !== 'Tab' || [input?.shellPid, input?.guestPid].includes(action.candidate.pid)))) group.errors.push({ error: 'A shared process or continuously active renderer was reclaimed' })
   group.activeInput = input
  }
  group.summary = { firstMiB: values[0], lastMiB: values.at(-1), minMiB: Math.min(...values), maxMiB: Math.max(...values), tailMedianMiB: percentile(tail,0.5), tailP95MiB: percentile(tail,0.95), lastCommitMiB: group.samples.at(-1)?.totalCommitBytes/1048576, successfulReclaims: actions.filter(a=>a.result).length, skippedReclaims: actions.filter(a=>!a.result).length, interactions: group.telemetry.interactions.length, errors: group.errors.length, wakeP50Ms: percentile(group.telemetry.interactions.filter(i=>!i.error).map(i=>i.wakeMs),0.5), wakeP95Ms: percentile(group.telemetry.interactions.filter(i=>!i.error).map(i=>i.wakeMs),0.95) }
  const frames = group.telemetry.interactions.filter(i=>!i.error&&Number.isFinite(i.frameRoundtripMs)).map(i=>i.frameRoundtripMs)
  group.summary.frameP50Ms = percentile(frames,0.5)
  group.summary.frameP95Ms = percentile(frames,0.95)
  for (const metric of ['wheelToScrollMs', 'interactionMs']) {
   const values = group.telemetry.interactions.filter(i => !i.error && Number.isFinite(i[metric])).map(i => i[metric])
   if (values.length) { group.summary[metric + 'P50'] = percentile(values, 0.5); group.summary[metric + 'P95'] = percentile(values, 0.95); group.summary[metric + 'Max'] = Math.max(...values) }
  }
  console.log(JSON.stringify({enabled,...group.summary, capacity: group.capacity,...(browsers ? { phases: group.phases } : {})}))
 }
 report.status = report.groups.every(g => g.errors.length === 0 && g.samples.length > 5 && g.summary.interactions >= 2) ? (functional ? 'FUNCTIONAL_PASS' : 'MEASURED') : 'INVALID'
} catch (error) { report.status = 'ERROR'; report.error = String(error) }
await writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2))
await writeFile(path.join(root,'local/resident-ab-latest.json'),JSON.stringify({evidence,status:report.status,error:report.error},null,2))
if (!['MEASURED', 'FUNCTIONAL_PASS'].includes(report.status)) process.exitCode = 1
