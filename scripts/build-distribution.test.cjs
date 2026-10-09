'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const build = require('./build-distribution.cjs')
const payload = require('./application-payload.cjs')
const application = require('./application-packaging.cjs')
const { createRuntime, pe } = require('./test-fixtures/application-runtime.cjs')
const u = require('./build-utils.cjs')

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
    preflightToolkit: async () => { calls.push('toolkit'); return { version: '1.2.0' } },
    assertToolkit: toolkit => { assert.equal(toolkit.version, '1.2.0') },
    buildPlugins: async options => { assert.equal(options.shipBundledResources, false); calls.push('plugins'); return [] },
    buildApplications: async () => { calls.push('applications'); return 'application' },
    buildPayloads: async ({ applications, architectures }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); calls.push('payload'); return [] },
    buildPortable: async ({ applications, architectures }) => { assert.equal(applications, 'application'); assert.deepEqual(architectures, ['x64', 'arm64']); calls.push('portable'); return [{ arch: 'universal', path: 'portable' }] },
    buildInstallers: async ({ toolkit, payloads, productVersion, edition }) => {
      assert.equal(toolkit.version, '1.2.0'); assert.deepEqual(payloads, []); assert.equal(productVersion, concept.version); assert.equal(edition, 'concept')
      calls.push('installers'); return { installers: [] }
    },
  }
}

test('public distribution modes do not depend on descriptive installer policy', () => {
  for (const identity of [concept, community]) {
    assert.equal(build.parseArguments([], identity).mode, 'all')
    for (const mode of ['portable', 'payload', 'all']) assert.equal(build.parseArguments(['--mode', mode], identity).mode, mode)
    for (const args of [['--publish'], ['--arches', 'x64'], ['--output', '--preflight']]) assert.throws(() => build.parseArguments(args, identity), /Usage/)
  }
  for (const mode of ['installer', 'complete']) {
    assert.equal(build.parseArguments(['--mode', mode], concept).mode, mode)
    assert.throws(() => build.parseArguments(['--mode', mode], community), /concept offline/)
  }
})

test('public packages share a single awaited application build and metadata baseline', async () => {
  for (const mode of ['portable', 'payload', 'all', 'installer', 'complete']) {
    const deps = dependencies()
    const artifacts = await build.buildCandidates(build.parseArguments(['--mode', mode], concept), 'output', deps)
    const packages = build.modePackages(mode, concept.edition)
    assert.deepEqual(deps.calls, [...(packages.installer ? ['toolkit'] : []), 'preflight', 'plugins', 'applications',
      ...(packages.payload ? ['payload'] : []), ...(packages.portable ? ['portable'] : []), ...(packages.installer ? ['installers'] : [])])
    assert.equal(artifacts.inputs.fingerprint, 'reviewed')
  }
})

test('installer preflight fails before native preparation and compilation', async () => {
  const deps = dependencies()
  deps.preflightToolkit = async () => { throw new Error('missing toolkit') }
  deps.prepareResources = async () => { throw new Error('unwanted native preparation') }
  await assert.rejects(build.buildCandidates(build.parseArguments(['--mode', 'complete'], concept), 'output', deps), /missing toolkit/)
  assert.deepEqual(deps.calls, [])
  const ready = dependencies()
  const result = await build.buildCandidates(build.parseArguments(['--mode', 'installer', '--preflight'], concept), 'output', ready)
  assert.equal(result.preflight, true)
  assert.deepEqual(ready.calls, ['toolkit', 'preflight'])
  const failure = dependencies()
  failure.buildInstallers = async () => { throw new Error('binary assembly failed') }
  await assert.rejects(build.buildCandidates(build.parseArguments(['--mode', 'installer'], concept), 'output', failure), /binary assembly failed/)
  assert.equal(failure.calls.includes('portable'), false)
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
  const assembledRoot = path.join(root, 'assembled')
  fs.mkdirSync(assembledRoot)
  const installers = ['x64', 'arm64'].map(architecture => {
    const file = path.join(assembledRoot, 'SidekickAI-Setup-' + concept.version + '-' + architecture + '.exe')
    fs.writeFileSync(file, pe(architecture))
    return { architecture, path: file, sha256: u.sha256(file), size: fs.statSync(file).size }
  })
  const assemblyResult = { authority: 'self-built', edition: concept.edition, productVersion: concept.version,
    issuerKeyId: 'local-builder', issuerFingerprint: 'a'.repeat(64),
    inputs: Object.fromEntries(payloads.map(item => [item.architecture, { manifestSha256: u.sha256(item.manifestPath), archiveSha256: u.sha256(item.path) }])),
    artifacts: installers.map(item => ({ architecture: item.architecture, role: 'offline-installer',
      path: 'installers/' + item.architecture + '/' + path.basename(item.path) })) }
  const retainedInputs = payloads.flatMap(item => [['application.manifest.json', item.manifestPath], [path.basename(item.path), item.path]]
    .map(([name, file]) => ({ file, path: 'inputs/' + item.architecture + '/' + name, architecture: item.architecture, sha256: u.sha256(file) })))
  const resultFile = path.join(assembledRoot, 'assembly-result.json')
  fs.writeFileSync(resultFile, JSON.stringify(assemblyResult))
  const completeRoot = path.join(root, 'complete')
  fs.mkdirSync(completeRoot)
  const complete = build.collectCandidates({ ...candidates, mode: 'complete', assembly: { installers, result: assemblyResult,
    resultFile, resultSha256: u.sha256(resultFile), retainedInputs, toolkit: { toolkitVersion: '1.2.0' } } }, completeRoot, root)
  assert.equal(complete.files.length, 12)
  assert.equal(complete.files.filter(file => file.role === 'offline-installer').length, 2)
  assert.equal(complete.manifest.assembly.issuerKeyId, 'local-builder')
  assert.equal(complete.manifest.assembly.authority, 'self-built')
  assert.ok(complete.files.filter(file => file.role === 'offline-installer').every(file => file.file.startsWith('installers/')))
  assert.deepEqual(fs.readFileSync(path.join(complete.directory, 'assembly-result.json')), fs.readFileSync(resultFile))
  assert.ok(complete.files.filter(file => file.role === 'offline-installer').every(file => file.contentType === 'application/vnd.microsoft.portable-executable'))
  const modifiedRoot = path.join(root, 'changed-result')
  fs.mkdirSync(modifiedRoot)
  fs.appendFileSync(resultFile, ' ')
  assert.throws(() => build.collectCandidates({ ...candidates, mode: 'complete', assembly: { installers, result: assemblyResult,
    resultFile, resultSha256: complete.manifest.assembly.resultSha256, retainedInputs, toolkit: {} } }, modifiedRoot, root), /result changed/)
  const changedInputRoot = path.join(root, 'changed-input')
  fs.mkdirSync(changedInputRoot)
  fs.appendFileSync(payloads[0].manifestPath, ' ')
  assert.throws(() => build.collectCandidates({ ...candidates, mode: 'complete', assembly: { installers, result: assemblyResult,
    resultFile, resultSha256: u.sha256(resultFile), retainedInputs, toolkit: {} } }, changedInputRoot, root), /payload changed after installer assembly/)
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
  const previous = build.captureInputs(root)
  fs.mkdirSync(path.join(root, 'maintenance'))
  fs.writeFileSync(path.join(root, 'maintenance/distribution-toolkit.json'), '{}')
  assert.notEqual(build.captureInputs(root).fingerprint, previous.fingerprint)
})
