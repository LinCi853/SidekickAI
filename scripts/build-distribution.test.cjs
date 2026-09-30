'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const build = require('./build-distribution.cjs')

const concept = { edition: 'concept', version: '0.1.5', packageKinds: ['installer', 'portable'] }
const community = { ...concept, edition: 'community', packageKinds: ['installer'] }

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-distribution-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function dependencies() {
  const calls = []
  let fingerprint = 'reviewed'
  return { calls, change: () => { fingerprint = 'changed' },
    captureInputs: () => ({ fingerprint, entries: [] }),
    preflight: async () => { calls.push('preflight'); return {} },
    buildPlugins: async options => { assert.equal(options.shipBundledResources, false); calls.push('plugins'); return [] },
    buildApplications: async () => { calls.push('applications'); return 'application' },
    buildInstallers: async (_output, applications) => { assert.equal(applications, 'application'); calls.push('installer'); return { setups: { x64: 'setup' } } },
    buildPortable: async ({ applications, architectures }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); calls.push('portable'); return [{ arch: 'universal', path: 'portable' }] },
  }
}

test('distribution policy rejects community portable and collection requests before a build', () => {
  assert.equal(build.parseArguments([], community).mode, 'installer')
  for (const mode of ['portable', 'all']) assert.throws(() => build.parseArguments(['--mode', mode], community), /does not distribute/)
  for (const mode of ['portable', 'all', 'installer']) assert.equal(build.parseArguments(['--mode', mode], concept).mode, mode)
  for (const args of [['--publish'], ['--arches', 'x64'], ['--mode', 'server']]) assert.throws(() => build.parseArguments(args, concept), /Usage/)
})

test('concept packages share a single awaited application build and metadata baseline', async () => {
  const deps = dependencies()
  const artifacts = await build.buildCandidates(build.parseArguments(['--mode', 'all'], concept), 'output', deps)
  assert.deepEqual(deps.calls, ['preflight', 'plugins', 'applications', 'installer', 'portable'])
  assert.equal(artifacts.inputs.fingerprint, 'reviewed')
})

test('preflight does not compile, and failed or drifting sources stop all dependent packages', async () => {
  const deps = dependencies()
  await build.buildCandidates(build.parseArguments(['--preflight'], community), 'output', deps)
  assert.deepEqual(deps.calls, ['preflight'])
  const drift = dependencies()
  drift.buildApplications = async () => { drift.change(); return 'application' }
  await assert.rejects(build.buildCandidates(build.parseArguments(['--mode', 'all'], concept), 'output', drift), /inputs changed/)
  assert.equal(drift.calls.includes('installer'), false)
  const failure = dependencies()
  failure.buildPlugins = async () => { throw new Error('plugin compilation failed') }
  await assert.rejects(build.buildCandidates(build.parseArguments([], community), 'output', failure), /plugin compilation failed/)
  assert.equal(failure.calls.includes('applications'), false)
})

test('same-name candidates are isolated by edition, hashed and never overwrite history', t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'maintenance'))
  fs.mkdirSync(path.join(root, 'packages/product-contract'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/product-contract/manifest.json'), JSON.stringify({ editions: { concept, community } }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: concept.version }))
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  fs.writeFileSync(path.join(root, 'maintenance/shared-source.json'), JSON.stringify({ schemaVersion: 1, files: { 'shared.cjs': 'source-digest' } }))
  const setup = path.join(root, 'setup.exe')
  const zip = path.join(root, 'portable.zip')
  fs.writeFileSync(setup, 'installer bytes')
  fs.writeFileSync(zip, 'portable bytes')
  const candidates = { ...build.parseArguments(['--mode', 'all'], concept), inputs: { fingerprint: 'source' },
    installers: { setups: { x64: setup } }, portable: [{ arch: 'universal', path: zip }] }
  const result = build.collectCandidates(candidates, root, root)
  assert.equal(result.manifest.status, 'candidate')
  assert.equal(result.files.length, 2)
  assert.ok(result.files.every(file => file.edition === 'concept' && /^[a-f0-9]{64}$/.test(file.sha256) && file.supportedArchitectures.length === 2))
  assert.deepEqual(result.files.map(file => file.packageKind), ['installer', 'portable'])
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'community' }))
  const sibling = build.collectCandidates({ ...candidates, ...community, mode: 'installer', portable: undefined }, root, root)
  assert.notEqual(sibling.directory, result.directory)
  assert.equal(sibling.files[0].file, result.files[0].file)
  assert.throws(() => build.collectCandidates(candidates, root, root), /identity/ )
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  assert.throws(() => build.collectCandidates(candidates, root, root), /EEXIST/)
  assert.equal(fs.readFileSync(path.join(result.directory, result.files[0].file), 'utf8'), 'installer bytes')
})

test('source fingerprints ignore generated artifacts and cover shared configuration', t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'packages/product-contract'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources/plugins'), { recursive: true })
  const product = path.join(root, 'packages/product-contract/manifest.json')
  fs.writeFileSync(product, '{}')
  const before = build.captureInputs(root)
  fs.writeFileSync(path.join(root, 'resources/plugins/generated.js'), 'generated')
  assert.equal(build.captureInputs(root).fingerprint, before.fingerprint)
  fs.writeFileSync(product, '{"version":"changed"}')
  assert.notEqual(build.captureInputs(root).fingerprint, before.fingerprint)
})

test('compiler configuration changes invalidate the candidate source baseline', t => {
  const root = temporary(t)
  for (const name of ['tsconfig.json', 'tsconfig.node.json']) fs.writeFileSync(path.join(root, name), '{}')
  const baseline = build.captureInputs(root)
  for (const name of ['tsconfig.json', 'tsconfig.node.json']) {
    fs.writeFileSync(path.join(root, name), '{"compilerOptions":{"target":"ES2022"}}')
    assert.notEqual(build.captureInputs(root).fingerprint, baseline.fingerprint)
    fs.writeFileSync(path.join(root, name), '{}')
    assert.equal(build.captureInputs(root).fingerprint, baseline.fingerprint)
  }
})
