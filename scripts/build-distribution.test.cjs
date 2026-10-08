'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const build = require('./build-distribution.cjs')
const versionedPe = require('./test-fixtures/versioned-pe.cjs')

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
    buildRecoveryEntries: async () => { calls.push('recovery'); return { x64: 'recovery-x64', arm64: 'recovery-arm64' } },
    buildInstallers: async (_output, applications, _architectures, _toolchain, recovery) => { assert.equal(applications, 'application'); assert.equal(recovery.arm64, 'recovery-arm64'); calls.push('installer'); return { setups: { x64: 'setup' } } },
    buildPortable: async ({ applications, architectures, recoveryEntries }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); assert.equal(recoveryEntries.x64, 'recovery-x64'); calls.push('portable'); return [{ arch: 'universal', path: 'portable' }] },
  }
}

test('distribution policy rejects community portable and collection requests before a build', () => {
  assert.equal(build.parseArguments([], community).mode, 'installer')
  assert.equal(build.parseArguments([], concept).mode, 'all')
  for (const mode of ['portable', 'all']) assert.throws(() => build.parseArguments(['--mode', mode], community), /does not distribute/)
  for (const mode of ['portable', 'all', 'installer']) assert.equal(build.parseArguments(['--mode', mode], concept).mode, mode)
  for (const args of [['--publish'], ['--arches', 'x64'], ['--mode', 'server']]) assert.throws(() => build.parseArguments(args, concept), /Usage/)
})
test('concept packages share a single awaited application build and metadata baseline', async () => {
  const deps = dependencies()
  const artifacts = await build.buildCandidates(build.parseArguments(['--mode', 'all'], concept), 'output', deps)
  assert.deepEqual(deps.calls, ['preflight', 'plugins', 'applications', 'recovery', 'installer', 'portable'])
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

test('native resources are prepared before source capture and omitted from preflight compilation', async () => {
  const deps = dependencies()
  deps.prepareResources = async () => { deps.calls.push('native'); deps.change() }
  const result = await build.buildCandidates(build.parseArguments([], community), 'output', deps)
  assert.equal(result.inputs.fingerprint, 'changed')
  assert.equal(deps.calls[0], 'native')
  const preflight = dependencies()
  preflight.prepareResources = async () => { throw new Error('Preflight must remain read-only') }
  await build.buildCandidates(build.parseArguments(['--preflight'], community), 'output', preflight)
})

test('candidate matrices retain architecture, visibility and immutable copies for each edition', t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'maintenance'))
  fs.mkdirSync(path.join(root, 'packages/product-contract'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/product-contract/manifest.json'), JSON.stringify({ editions: { concept, community } }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: concept.version }))
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  fs.writeFileSync(path.join(root, 'maintenance/shared-source.json'), JSON.stringify({ schemaVersion: 1, files: { 'shared.cjs': 'source-digest' } }))
  const setups = Object.fromEntries(['x64', 'arm64'].map(arch => {
    const file = path.join(root, 'setup-' + arch + '.exe')
    fs.writeFileSync(file, versionedPe(arch))
    return [arch, file]
  }))
  const zip = path.join(root, 'portable.zip')
  fs.writeFileSync(zip, 'portable bytes')
  const digest = 'a'.repeat(64)
  const payloads = Object.fromEntries(['x64', 'arm64'].map(arch => [arch, { bodyProofSha256: digest, container: { path: zip } }]))
  const candidates = { ...build.parseArguments(['--mode', 'all'], concept), inputs: { fingerprint: 'source' },
    installers: { setups, payloads }, portable: [{ arch: 'universal', path: zip, bodyProofSha256: digest }] }
  const result = build.collectCandidates(candidates, root, root)
  assert.equal(result.manifest.status, 'candidate')
  assert.equal(result.files.length, 3)
  assert.ok(result.files.every(file => file.edition === 'concept' && /^[a-f0-9]{64}$/.test(file.sha256) && file.visibility === 'public'))
  assert.deepEqual(result.files.map(file => file.role), ['offline-installer', 'offline-installer', 'portable'])
  assert.deepEqual(result.files.map(file => file.supportedNativeArchitectures), [['x64'], ['arm64'], ['x64', 'arm64']])
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'application-release-candidate.json'))).publicAssetIds.length, 3)
  const prerelease = '0.1.5-alpha+20261008.001'
  const prereleaseOutput = path.join(root, 'prerelease')
  fs.mkdirSync(prereleaseOutput)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: prerelease }))
  const alpha = build.collectCandidates({ ...candidates, version: prerelease }, prereleaseOutput, root)
  assert.equal(alpha.manifest.channel, 'alpha')
  assert.equal(JSON.parse(fs.readFileSync(path.join(alpha.directory, 'application-release-candidate.json'))).channel, 'alpha')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: concept.version }))
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'community' }))
  const sibling = build.collectCandidates({ ...candidates, ...community, mode: 'installer', portable: undefined }, root, root)
  assert.notEqual(sibling.directory, result.directory)
  assert.deepEqual(sibling.files.map(file => file.role), ['online-bootstrap', 'application-payload', 'application-payload'])
  assert.deepEqual(sibling.files.map(file => file.visibility), ['public', 'internal', 'internal'])
  assert.equal(sibling.files[0].executableArchitecture, 'x64')
  assert.equal(sibling.files[0].bodyProofSha256, null)
  assert.deepEqual(sibling.files[0].supportedNativeArchitectures, ['x64', 'arm64'])
  assert.throws(() => build.collectCandidates(candidates, root, root), /identity/ )
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  assert.throws(() => build.collectCandidates(candidates, root, root), /EEXIST/)
  assert.deepEqual(fs.readFileSync(path.join(result.directory, result.files[0].file)), fs.readFileSync(setups.x64))
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
  fs.mkdirSync(path.join(root, 'tools/backup-recovery-native/src'), { recursive: true })
  const recovery = path.join(root, 'tools/backup-recovery-native/src/main.rs')
  const recoveryBefore = build.captureInputs(root)
  fs.writeFileSync(recovery, 'fn main() {}')
  assert.notEqual(build.captureInputs(root).fingerprint, recoveryBefore.fingerprint)
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
