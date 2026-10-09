'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const build = require('./build-distribution.cjs')
const payload = require('./application-payload.cjs')
const application = require('./application-packaging.cjs')
const { createRuntime } = require('./test-fixtures/application-runtime.cjs')

const concept = { edition: 'concept', version: application.VERSION, packageKinds: ['installer', 'portable'] }
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
    buildPayloads: async ({ applications, architectures }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); calls.push('payload'); return [] },
    buildPortable: async ({ applications, architectures }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); calls.push('portable'); return [{ arch: 'universal', path: 'portable' }] },
  }
}

test('public distribution modes do not depend on descriptive installer policy', () => {
  for (const identity of [concept, community]) {
    assert.equal(build.parseArguments([], identity).mode, 'all')
    for (const mode of ['portable', 'payload', 'all']) assert.equal(build.parseArguments(['--mode', mode], identity).mode, mode)
    for (const args of [['--publish'], ['--arches', 'x64'], ['--mode', 'installer'], ['--output', '--preflight']]) assert.throws(() => build.parseArguments(args, identity), /Usage/)
  }
})

test('public packages share a single awaited application build and metadata baseline', async () => {
  for (const mode of ['portable', 'payload', 'all']) {
    const deps = dependencies()
    const artifacts = await build.buildCandidates(build.parseArguments(['--mode', mode], concept), 'output', deps)
    assert.deepEqual(deps.calls, ['preflight', 'plugins', 'applications', ...(mode === 'portable' ? [] : ['payload']), ...(mode === 'payload' ? [] : ['portable'])])
    assert.equal(artifacts.inputs.fingerprint, 'reviewed')
  }
})

test('preflight does not compile, and failed or drifting sources stop dependent packages', async () => {
  const deps = dependencies()
  await build.buildCandidates(build.parseArguments(['--preflight'], community), 'output', deps)
  assert.deepEqual(deps.calls, ['preflight'])
  const drift = dependencies()
  drift.buildApplications = async () => { drift.change(); return 'application' }
  await assert.rejects(build.buildCandidates(build.parseArguments([], concept), 'output', drift), /inputs changed/)
  assert.equal(drift.calls.includes('payload'), false)
  const failure = dependencies()
  failure.buildPlugins = async () => { throw new Error('plugin compilation failed') }
  await assert.rejects(build.buildCandidates(build.parseArguments([], community), 'output', failure), /plugin compilation failed/)
  assert.equal(failure.calls.includes('applications'), false)
})

test('native application resources are prepared before capture and omitted from preflight compilation', async () => {
  const deps = dependencies()
  deps.prepareResources = async () => { deps.calls.push('native'); deps.change() }
  const result = await build.buildCandidates(build.parseArguments([], concept), 'output', deps)
  assert.equal(result.inputs.fingerprint, 'changed')
  assert.equal(deps.calls[0], 'native')
  const preflight = dependencies()
  preflight.prepareResources = async () => { throw new Error('Preflight must remain read-only') }
  await build.buildCandidates(build.parseArguments(['--preflight'], concept), 'output', preflight)
})

test('candidates retain both native payload manifests, one green archive and immutable copies', async t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'maintenance'))
  fs.mkdirSync(path.join(root, 'packages/product-contract'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/product-contract/manifest.json'), JSON.stringify({ editions: { concept, community } }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: concept.version }))
  fs.writeFileSync(path.join(root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  fs.writeFileSync(path.join(root, 'maintenance/shared-source.json'), JSON.stringify({ schemaVersion: 1, files: {} }))
  const payloads = []
  for (const architecture of ['x64', 'arm64']) {
    const source = await createRuntime(root, architecture)
    payloads.push(payload.packApplicationPayload({ source, output: path.join(root, 'payloads'), architecture }))
  }
  const zip = path.join(root, 'portable.zip')
  fs.writeFileSync(zip, 'portable bytes')
  const candidates = { ...build.parseArguments([], concept), inputs: { fingerprint: 'source' }, payloads, portable: [{ arch: 'universal', path: zip }] }
  const result = build.collectCandidates(candidates, root, root)
  assert.equal(result.manifest.status, 'candidate')
  assert.equal(result.files.length, 5)
  assert.deepEqual(result.files.map(file => file.role), ['application-payload', 'application-payload-manifest', 'application-payload', 'application-payload-manifest', 'portable'])
  assert.deepEqual(result.files.map(file => file.architecture), ['x64', 'x64', 'arm64', 'arm64', 'universal'])
  assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && !Object.hasOwn(file, 'bodyProofSha256')))
  assert.equal(fs.existsSync(path.join(result.directory, 'application-release-candidate.json')), false)
  assert.throws(() => build.collectCandidates(candidates, root, root), /EEXIST/)
  assert.deepEqual(fs.readFileSync(path.join(result.directory, result.files[0].file)), fs.readFileSync(payloads[0].path))
  const output = path.join(root, 'tampered')
  fs.mkdirSync(output)
  fs.appendFileSync(payloads[0].path, 'tampered')
  assert.throws(() => build.collectCandidates(candidates, output, root), /does not match/)
})

test('public source fingerprints cover application configuration and ignore private installation sources', t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'packages/product-contract'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources/plugins'), { recursive: true })
  const product = path.join(root, 'packages/product-contract/manifest.json')
  fs.writeFileSync(product, '{}')
  const before = build.captureInputs(root)
  fs.writeFileSync(path.join(root, 'resources/plugins/generated.js'), 'generated')
  fs.mkdirSync(path.join(root, 'tools/backup-recovery-native/src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tools/backup-recovery-native/src/main.rs'), 'fn main() {}')
  fs.mkdirSync(path.join(root, 'private-distribution'), { recursive: true })
  fs.writeFileSync(path.join(root, 'private-distribution/product.rs'), 'private fixture')
  assert.equal(build.captureInputs(root).fingerprint, before.fingerprint)
  fs.writeFileSync(product, '{"version":"changed"}')
  assert.notEqual(build.captureInputs(root).fingerprint, before.fingerprint)
  for (const name of ['tsconfig.json', 'tsconfig.node.json']) {
    const previous = build.captureInputs(root)
    fs.writeFileSync(path.join(root, name), '{"compilerOptions":{"target":"ES2022"}}')
    assert.notEqual(build.captureInputs(root).fingerprint, previous.fingerprint)
  }
})
