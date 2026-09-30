'use strict'

const fs = require('node:fs')
const path = require('node:path')
const u = require('./uninstaller-build-utils.cjs')
const cache = require('./build-cache.cjs')
const { isProduction } = require('./maintenance-inputs.cjs')
const evidence = require('./build-evidence.cjs')
const { toolInputs } = require('./build-tool-inputs.cjs')

const ROOT = path.resolve(__dirname, '..')

function inputs(root = ROOT, complete = false) {
  const source = ['electron', 'src', 'packages/product-contract', 'packages/desktop-common',
    'resources', 'product-edition.json', 'package.json', 'package-lock.json', 'electron.vite.config.ts',
    'scripts/compilation-inputs.ts', 'tsconfig.json', 'tsconfig.node.json']
  const list = source.flatMap(relative => {
    const location = path.join(root, relative)
    if (!fs.existsSync(location)) throw new Error(`Application compilation input is missing: ${relative}`)
    return fs.statSync(location).isDirectory() ? u.listFiles(location).filter(isProduction) : [location]
  })
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  for (const name of Object.keys(lock.packages).filter(name => name.startsWith('node_modules/'))) {
    const location = path.join(root, name)
    if (fs.existsSync(location)) {
      if (complete || /^node_modules\/@fontsource/.test(name)) list.push(...u.listFiles(location, new Set(['node_modules', '.git'])))
      else if (fs.existsSync(path.join(location, 'package.json'))) list.push(path.join(location, 'package.json'))
    }
  }
  list.push(...toolInputs(root, ['electron-vite', '@vitejs/plugin-react', 'esbuild', 'rollup']))
  return [...new Set(list)].sort()
}

function dependencyInputs(directory, root) {
  const paths = new Set()
  for (const target of ['main', 'preload', 'renderer']) {
    const proof = JSON.parse(fs.readFileSync(path.join(directory, target, 'compilation-inputs.json'), 'utf8'))
    if (proof.schemaVersion !== 1 || proof.target !== target || !Array.isArray(proof.modules) || !Array.isArray(proof.outputs)) throw new Error('Invalid compilation dependency evidence')
    for (const relative of [...proof.modules, ...proof.outputs.flatMap(output => output.sources ?? [])]) {
      const file = path.resolve(root, relative)
      if (!file.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(file)) throw new Error(`Compilation dependency is missing or outside the workspace: ${relative}`)
      paths.add(file)
    }
  }
  return [...paths].sort()
}

function compile(output, run, root = ROOT, cacheRoot = cache.ROOT) {
  const started = Date.now()
  const before = u.fingerprint(root, inputs(root))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(NODE_ENV|ELECTRON_|VITE_|TAURI_ENV_)/.test(name)))
  const key = u.hash(JSON.stringify({ inputs: before.fingerprint, node: process.version, environment }))
  const decision = cache.inspect('application-build', key, cacheRoot)
  const destination = path.join(root, 'out')
  if (decision.value) {
    try {
      const actual = u.fingerprint(root, dependencyInputs(decision.value.directory, root))
      if (actual.fingerprint !== decision.value.dependencies.fingerprint) Object.assign(decision, { value: null, reason: 'dependency-changed' })
    } catch { Object.assign(decision, { value: null, reason: 'dependency-missing' }) }
  }
  if (decision.value) {
    const retained = decision.value.directory
    const expected = cache.snapshot(retained)
    if (!fs.existsSync(destination) || cache.snapshot(destination) !== expected) {
      const resolved = path.resolve(destination)
      if (path.dirname(resolved) !== path.resolve(root) || path.basename(resolved) !== 'out') throw new Error('Unsafe application output directory')
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true })
      fs.cpSync(retained, destination, { recursive: true, errorOnExist: true, force: false })
    }
    if (cache.snapshot(destination) !== expected || cache.snapshot(retained) !== expected) throw new Error('Application compilation cache changed during reuse')
  } else {
    let previousDependencies = []
    try { previousDependencies = dependencyInputs(destination, root) } catch { /* Obsolete output evidence cannot prevent a rebuild. */ }
    const completeInputs = [...new Set([...inputs(root, true), ...previousDependencies])]
    const guarded = u.fingerprint(root, completeInputs)
    run(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], 'Current application build')
    u.assertUnchanged(before, u.fingerprint(root, inputs(root)))
    u.assertUnchanged(guarded, u.fingerprint(root, completeInputs))
    const dependencies = u.fingerprint(root, dependencyInputs(destination, root))
    const guardedPaths = new Set(guarded.entries.map(entry => entry.path))
    const unguarded = dependencies.entries.filter(entry => !guardedPaths.has(entry.path)).map(entry => entry.path)
    if (unguarded.length) throw new Error(`Compilation introduced inputs outside the guarded source set: ${unguarded.join(', ')}`)
    const contentKey = u.hash(JSON.stringify({ key, dependencies: dependencies.fingerprint }))
    const directory = cache.retainDirectory('application-build', contentKey, destination, cacheRoot)
    cache.remember('application-build', key, [directory], { directory, dependencies }, cacheRoot)
  }
  u.assertUnchanged(before, u.fingerprint(root, inputs(root)))
  if (decision.value) u.assertUnchanged(decision.value.dependencies, u.fingerprint(root, dependencyInputs(decision.value.directory, root)))
  const result = { key, sourceInputs: before, dependencies: u.fingerprint(root, dependencyInputs(destination, root)),
    outputFingerprint: cache.snapshot(destination), directory: destination }
  evidence.record(output, 'application-build', key, decision, started, { outputFingerprint: result.outputFingerprint })
  return result
}

module.exports = { inputs, dependencyInputs, compile }
