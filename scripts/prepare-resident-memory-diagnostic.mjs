import { build } from 'esbuild'
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Experimental builds only. Keep production output untouched when testing
// renderer Node runtimes and the shell's continuous decorative animation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// --renderer-node intentionally restores the full renderer Node runtime for a
// control build. The old --keep-renderer-node spelling remains compatible.
const sandbox = !process.argv.includes('--keep-renderer-node') && !process.argv.includes('--renderer-node')
const staticIndicator = process.argv.includes('--static-indicator')
const cpuIndex = process.argv.indexOf('--idle-cpu-percent')
const idleCpuPercent = cpuIndex < 0 ? null : Number(process.argv[cpuIndex + 1])
if (idleCpuPercent !== null && (!Number.isFinite(idleCpuPercent) || idleCpuPercent < 0.5 || idleCpuPercent > 2)) throw new Error('Diagnostic CPU threshold must be 0.5..2 percent of one core')
const directory = await mkdtemp(path.join(root, 'local/resident-variant-'))
const output = path.join(directory, 'out')
await mkdir(path.join(output, 'preload'), { recursive: true })
await cp(path.join(root, 'out/main'), path.join(output, 'main'), { recursive: true })
await cp(path.join(root, 'out/renderer'), path.join(output, 'renderer'), { recursive: true })
const changes = []
let cpuChanges = 0
let sandboxPreferences = 0
let baselineIdleCpuPercent
for (const name of await readdir(path.join(output, 'main'))) {
 if (!name.endsWith('.cjs')) continue
 const file = path.join(output, 'main', name)
 const before = await readFile(file, 'utf8')
 const cpuMatch = before.match(/const MAX_IDLE_CPU_PERCENT = ([\d.]+)/) ?? before.match(/\.cpuPercent > ([\d.]+)/)
 if (cpuMatch) baselineIdleCpuPercent = Number(cpuMatch[1])
 let after = before.replace(/\bsandbox(?:\s*:\s*|\s*=\s*)(true|false)\b/g, (value, previous) => { sandboxPreferences++; return value.slice(0, -previous.length) + String(sandbox) })
 if (idleCpuPercent !== null) after = after.replace(/(const MAX_IDLE_CPU_PERCENT = |\.cpuPercent > )[\d.]+/g, (_value, prefix) => { cpuChanges++; return prefix + idleCpuPercent })
 if (after !== before) { await writeFile(file, after); changes.push(name) }
}
if (!sandboxPreferences) throw new Error('No sandbox preferences were found; the diagnostic is stale')
if (!Number.isFinite(baselineIdleCpuPercent) || (idleCpuPercent !== null && cpuChanges !== 1)) throw new Error('The diagnostic CPU threshold did not match exactly one policy check')
if (!sandbox) await cp(path.join(root, 'out/preload'), path.join(output, 'preload'), { recursive: true })
for (const [name, source] of sandbox ? [['index', 'electron/preload.ts'], ['webview', 'electron/webview-preload.ts']] : []) {
 await build({ absWorkingDir: root, entryPoints: [source], outfile: path.join(output, 'preload', name + '.cjs'),
  bundle: true, splitting: false, format: 'cjs', platform: 'node', target: 'node22', external: ['electron'], logLevel: 'silent' })
}
const replaceOnce = (source, before, after) => {
 if (source.split(before).length !== 2) throw new Error('Diagnostic source shape changed: ' + before)
 return source.replace(before, after)
}
let fixture = await readFile(path.join(root, 'scripts/resident-memory-fixture.cjs'), 'utf8')
fixture = replaceOnce(fixture, "const root = path.resolve(__dirname, '..')", 'const root = ' + JSON.stringify(root))
fixture = replaceOnce(fixture, "require(path.join(root, 'out/main/index.cjs'))", 'require(' + JSON.stringify(path.join(output, 'main/index.cjs')) + ')')
if (staticIndicator) fixture = replaceOnce(fixture, '   identity = { guestId:', '   await win.webContents.insertCSS(".tab-bar.is-collapsible:not(.is-expanded) .tab-indicator.active { animation: none !important; }")\n   identity = { guestId:')
await writeFile(path.join(directory, 'fixture.cjs'), fixture)
let measure = await readFile(path.join(root, 'scripts/verify-resident-memory-ab.mjs'), 'utf8')
measure = replaceOnce(measure, "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')", 'const root = ' + JSON.stringify(root))
measure = replaceOnce(measure, "from './memory-state-contract.mjs'", 'from ' + JSON.stringify(new URL('./memory-state-contract.mjs', import.meta.url).href))
measure = replaceOnce(measure, "path.join(root, 'scripts/resident-memory-fixture.cjs')", JSON.stringify(path.join(directory, 'fixture.cjs')))
measure = replaceOnce(measure, "workload: 'production-default-startup'", "workload: 'experimental-resident-variant'")
measure = replaceOnce(measure, 'readFile(path.join(root,relative))', 'readFile(path.join(relative.startsWith("out/") ? ' + JSON.stringify(directory) + ' : root,relative))')
measure = replaceOnce(measure, 'readdir(path.join(root,directory)', 'readdir(path.join(' + JSON.stringify(directory) + ',directory)')
await writeFile(path.join(directory, 'measure.mjs'), measure)
const inputs = ['out/main/index.cjs', 'out/preload/index.cjs', 'out/preload/webview.cjs', 'scripts/resident-memory-fixture.cjs', 'scripts/verify-resident-memory-ab.mjs', 'electron/preload.ts', 'electron/webview-preload.ts']
const hashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])))
const outputs = {}
outputs['fixture.cjs'] = createHash('sha256').update(fixture).digest('hex')
for (const subdirectory of ['main', 'preload']) {
 for (const name of await readdir(path.join(output, subdirectory))) {
  if (name.endsWith('.cjs')) outputs['out/' + subdirectory + '/' + name] = createHash('sha256').update(await readFile(path.join(output, subdirectory, name))).digest('hex')
 }
}
const metadata = { experimental: true, sandbox, staticIndicator, idleCpuPercent: idleCpuPercent ?? baselineIdleCpuPercent, baselineIdleCpuPercent, productionOutputUnchanged: true, changes, hashes, outputs, createdAt: new Date().toISOString() }
await writeFile(path.join(directory, 'diagnostic.json'), JSON.stringify(metadata, null, 2))
// The copied main entry keeps its name while experimental chunk contents change.
// Record every main/preload artifact, rather than relying on its entry hash.
await writeFile(path.join(directory, 'measure.mjs'), measure + '\nreport.variant = ' + JSON.stringify(metadata) + '\nawait writeFile(path.join(evidence,"report.json"),JSON.stringify(report,null,2))\n')
console.log(directory)
console.log('Run serially after other memory measurements: node ' + JSON.stringify(path.join(directory, 'measure.mjs')) + ' 120 --enabled-only')
