'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const assembly = require('./assemble-application.cjs')
const distribution = require('./build-distribution.cjs')
const toolkitApi = require('./distribution-toolkit.cjs')
const u = require('./build-utils.cjs')
const { pe } = require('./test-fixtures/application-runtime.cjs')
const { fixtureRoot, writeToolkit, createPayloads, assemblyResult, mockAssembler } =
  require('./test-fixtures/distribution-toolkit.cjs')

async function context(t, withPayloads = false, configurable = false) {
  const directory = fixtureRoot(t)
  const root = path.join(directory, 'workspace with spaces & punctuation')
  const fixture = require('./test-fixtures/distribution-toolkit.cjs').toolkitFixture()
  if (configurable) {
    fixture.manifest.toolkitVersion = '1.3.0'
    fixture.manifest.installationConfigurationVersion = 1
  }
  const published = writeToolkit(path.join(directory, 'published'), fixture)
  t.mock.method(toolkitApi, 'prepareToolkit', published.toolkit.prepareToolkit)
  const toolkit = await toolkitApi.prepareToolkit(root, { reference: published.reference })
  const payloads = withPayloads ? await createPayloads(path.join(root, 'source')) : undefined
  return { directory, root, published, toolkit, payloads }
}

function requestFor(value, outputDirectory) {
  return { outputDirectory, payloads: Object.fromEntries(value.payloads.map(item => [item.architecture, item.manifestPath])) }
}

function optionsFor(value, spawn, output = path.join(value.root, 'candidate')) {
  return { root: value.root, output, payloads: value.payloads, edition: 'concept', productVersion: '9.4.2',
    toolkit: value.toolkit, invokeOptions: { spawn } }
}

function collect(value, assembled, name, mode = 'installer') {
  fs.mkdirSync(path.join(value.root, 'packages/product-contract'), { recursive: true })
  fs.mkdirSync(path.join(value.root, 'maintenance'), { recursive: true })
  fs.writeFileSync(path.join(value.root, 'package.json'), JSON.stringify({ version: '9.4.2' }))
  fs.writeFileSync(path.join(value.root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  fs.writeFileSync(path.join(value.root, 'packages/product-contract/manifest.json'), JSON.stringify({ editions: { concept: {} } }))
  fs.writeFileSync(path.join(value.root, 'maintenance/shared-source.json'), JSON.stringify({ schemaVersion: 1, files: [] }))
  const output = path.join(value.root, 'collected-' + name)
  fs.mkdirSync(output)
  const portableFile = path.join(value.root, 'portable.zip')
  if (mode === 'complete') fs.writeFileSync(portableFile, 'fixture portable archive')
  return distribution.collectCandidates({ edition: 'concept', version: '9.4.2', mode,
    ...(mode === 'complete' ? { portable: [{ arch: 'universal', path: portableFile }] } : {}),
    architectures: ['x64', 'arm64'], payloads: value.payloads, assembly: assembled,
    inputs: { fingerprint: 'fixture-source-inputs', entries: [] } }, output, value.root)
}

test('binary invocation preserves argv boundaries, hides the window and parses the final JSON line', async t => {
  const { toolkit } = await context(t)
  const argument = 'C:/build path/contains & shell punctuation/request.json'
  let call
  const value = assembly.invoke(toolkit, ['assemble', '--request', argument], {
    spawn(executable, args, options) {
      call = { executable, args, options }
      return { status: 0, stderr: '', stdout: 'diagnostic output\r\n{"verified":true}\r\n' }
    },
  })
  assert.deepEqual(value, { verified: true })
  assert.equal(call.executable, path.join(toolkit.directory, 'bin/SidekickDistribution.exe'))
  assert.deepEqual(call.args, ['assemble', '--request', argument])
  assert.equal(call.options.cwd, toolkit.directory)
  assert.equal(call.options.shell, false)
  assert.equal(call.options.windowsHide, true)
  assert.equal(call.options.encoding, 'utf8')
  assert.ok(call.options.maxBuffer > 0)
})

test('binary invocation fails closed on process errors, nonzero status or missing JSON', async t => {
  const { toolkit } = await context(t)
  for (const result of [
    { status: null, error: new Error('fixture launch failure') },
    { status: 7, stderr: 'fixture process failure', stdout: '{"verified":true}' },
    { status: null, signal: 'SIGTERM', stdout: '{"verified":true}' },
    { status: 0, stdout: 'not JSON' },
    { status: 0, stdout: '' },
  ]) assert.throws(() => assembly.invoke(toolkit, ['inspect'], { spawn: () => result }))
})

test('binary inspection must match the pinned interface, toolkit and capability', async t => {
  const { toolkit } = await context(t)
  const valid = { interfaceVersion: 1, toolkitVersion: '1.2.0', verified: true,
    capabilities: structuredClone(toolkit.manifest.capabilities) }
  const spawn = result => () => ({ status: 0, stdout: JSON.stringify(result) })
  assert.deepEqual(assembly.inspectToolkit(toolkit, { spawn: spawn(valid) }), valid)
  for (const change of [
    value => { value.interfaceVersion = 2 },
    value => { value.toolkitVersion = '1.2.1' },
    value => { value.verified = false },
    value => { value.capabilities[0].authority = 'official' },
    value => { value.capabilities[0].architectures = ['x64'] },
    value => { value.capabilities.push(structuredClone(value.capabilities[0])) },
  ]) {
    const result = structuredClone(valid)
    change(result)
    assert.throws(() => assembly.inspectToolkit(toolkit, { spawn: spawn(result) }), /inspection/)
  }
})

test('preflight rejects unsupported platforms before downloading or invoking anything', async t => {
  const root = fixtureRoot(t)
  let invoked = false
  await assert.rejects(assembly.preflight({ root, toolkitOptions: { platform: 'linux' },
    invokeOptions: { spawn() { invoked = true; throw new Error('unexpected process') } } }), /Windows/)
  assert.equal(invoked, false)
  assert.equal(fs.existsSync(path.join(root, 'build')), false)
})

test('preflight rejects foreign release identities before binary invocation', async t => {
  const root = fixtureRoot(t)
  for (const change of [
    value => { value.toolkitVersion = '1.3.2' },
    value => { value.archive.size++ },
    value => { value.archive.sha256 = '0'.repeat(64) },
  ]) {
    const reference = structuredClone(require('../maintenance/distribution-toolkit.json'))
    change(reference)
    await assert.rejects(assembly.preflight({ root, toolkitOptions: { reference, platform: 'win32' },
      invokeOptions: { spawn() { assert.fail('Foreign references must not invoke the assembler') } } }), /trusted release/)
    assert.equal(fs.existsSync(path.join(root, 'build')), false)
  }
})

test('binary invocation rechecks toolkit bytes both before and after the process', async t => {
  for (const timing of ['before', 'during']) await t.test(timing, async sub => {
    const { toolkit } = await context(sub)
    let invoked = false
    const mutate = () => fs.appendFileSync(path.join(toolkit.directory, 'LICENSE.txt'), 'changed')
    if (timing === 'before') mutate()
    assert.throws(() => assembly.invoke(toolkit, ['inspect'], { spawn() {
      invoked = true
      mutate()
      return { status: 0, stdout: '{"verified":true}' }
    } }), /pinned identity/)
    assert.equal(invoked, timing === 'during')
  })
})

test('input identity binds both real application archives and their exact external manifests', async t => {
  const value = await context(t, true)
  const identity = assembly.inputIdentity(value.payloads, 'concept', '9.4.2')
  assert.deepEqual(Object.keys(identity.inputs), ['x64', 'arm64'])
  for (const payload of value.payloads) {
    assert.equal(identity.manifests[payload.architecture], path.resolve(payload.manifestPath))
    assert.deepEqual(identity.inputs[payload.architecture], {
      manifestSha256: u.sha256(payload.manifestPath), archiveSha256: u.sha256(payload.path),
    })
  }
  assert.equal(identity.files.length, 4)
  assert.equal(identity.fingerprint.entries.length, 4)
  for (const payloads of [[], value.payloads.slice(0, 1), [value.payloads[0], value.payloads[0]]]) {
    assert.throws(() => assembly.inputIdentity(payloads, 'concept', '9.4.2'), /payload/)
  }
  assert.throws(() => assembly.inputIdentity(value.payloads, 'community', '9.4.2'), /concept/)
  assert.throws(() => assembly.inputIdentity(value.payloads, 'concept', '1.2.0'), /identity/)
})

test('input validation rejects manifest identity drift and archive replacement', async t => {
  const value = await context(t, true)
  const payload = value.payloads[1]
  const originalManifest = fs.readFileSync(payload.manifestPath)
  const originalArchive = fs.readFileSync(payload.path)
  for (const change of [
    manifest => { manifest.edition = 'community' },
    manifest => { manifest.architecture = 'x64' },
    manifest => { manifest.productVersion = '9.4.3' },
    manifest => { manifest.archive.sha256 = '0'.repeat(64) },
  ]) {
    const manifest = JSON.parse(originalManifest)
    change(manifest)
    fs.writeFileSync(payload.manifestPath, JSON.stringify(manifest))
    assert.throws(() => assembly.inputIdentity(value.payloads, 'concept', '9.4.2'), /identity/)
  }
  fs.writeFileSync(payload.manifestPath, originalManifest)
  fs.appendFileSync(payload.path, 'replacement')
  assert.throws(() => assembly.inputIdentity(value.payloads, 'concept', '9.4.2'), /archive identity/)
  fs.writeFileSync(payload.path, originalArchive)
  fs.writeFileSync(payload.manifestPath, ' '.repeat(4 * 1024 * 1024 + 1))
  assert.throws(() => assembly.inputIdentity(value.payloads, 'concept', '9.4.2'), /size limit/)
})

test('application input manifests can use the full four MiB binary interface limit', async t => {
  const value = await context(t, true)
  for (const payload of value.payloads) {
    fs.appendFileSync(payload.manifestPath, ' '.repeat(2 * 1024 * 1024 - fs.statSync(payload.manifestPath).size))
  }
  const identity = assembly.inputIdentity(value.payloads, 'concept', '9.4.2')
  for (const payload of value.payloads) assert.equal(identity.inputs[payload.architecture].manifestSha256, u.sha256(payload.manifestPath))
})

test('assembly result acceptance binds authority, application identity, inputs and both installer architectures', async t => {
  const value = await context(t, true)
  const output = path.join(value.root, 'result')
  const valid = assemblyResult(requestFor(value, output), value.toolkit)
  const identity = { edition: 'concept', productVersion: '9.4.2', inputs: structuredClone(valid.inputs) }
  const installers = assembly.validateResult(valid, value.toolkit, output, identity)
  assert.deepEqual(installers.map(item => item.architecture), ['x64', 'arm64'])
  for (const change of [
    result => { result.interfaceVersion = 2 },
    result => { result.toolkitVersion = '1.2.1' },
    result => { result.edition = 'community' },
    result => { result.productVersion = '1.2.0' },
    result => { result.authority = 'official' },
    result => { result.mode = 'online' },
    result => { result.issuerKeyId = '' },
    result => { result.issuerKeyId = 'identity with spaces' },
    result => { delete result.issuerFingerprint },
    result => { result.issuerFingerprint = 'not-a-fingerprint' },
    result => { result.inputs.arm64.manifestSha256 = '0'.repeat(64) },
    result => { delete result.inputs.x64 },
    result => { result.artifacts.pop() },
    result => { result.artifacts.push(structuredClone(result.artifacts[0])) },
    result => { result.artifacts[1].architecture = 'x64' },
    result => { result.artifacts[0].role = 'online-bootstrap' },
    result => { result.artifacts[0].size += 1 },
    result => { result.artifacts[0].sha256 = '0'.repeat(64) },
    result => { result.artifacts[0].size = 0 },
  ]) {
    const result = structuredClone(valid)
    change(result)
    assert.throws(() => assembly.validateResult(result, value.toolkit, output, identity))
  }
  const swapped = structuredClone(valid)
  const x64 = path.join(output, swapped.artifacts[0].path)
  fs.writeFileSync(x64, pe('arm64'))
  swapped.artifacts[0].sha256 = u.sha256(x64)
  assert.throws(() => assembly.validateResult(swapped, value.toolkit, output, identity), /bytes/)
})

test('installer result paths reject escape, duplicate names, non-files and linked directories', async t => {
  const value = await context(t, true)
  const output = path.join(value.root, 'result')
  const valid = assemblyResult(requestFor(value, output), value.toolkit)
  const identity = { edition: 'concept', productVersion: '9.4.2', inputs: structuredClone(valid.inputs) }
  for (const name of ['../outside.exe', '/absolute.exe', 'C:/outside.exe', 'bin\\outside.exe',
    'CON.exe', 'trailing.exe. ', 'without-extension', valid.artifacts[1].path.toUpperCase()]) {
    const result = structuredClone(valid)
    result.artifacts[0].path = name
    assert.throws(() => assembly.validateResult(result, value.toolkit, output, identity), undefined, name)
  }
  const nested = structuredClone(valid)
  const original = path.join(output, nested.artifacts[0].path)
  const outside = path.join(value.root, 'external-artifacts')
  fs.mkdirSync(outside)
  fs.copyFileSync(original, path.join(outside, nested.artifacts[0].path))
  fs.symlinkSync(outside, path.join(output, 'linked'), 'junction')
  nested.artifacts[0].path = 'linked/' + nested.artifacts[0].path
  assert.throws(() => assembly.validateResult(nested, value.toolkit, output, identity), /linked/)
  fs.unlinkSync(original)
  fs.mkdirSync(original)
  assert.throws(() => assembly.validateResult(valid, value.toolkit, output, identity), /regular file/)
})

test('mock assembler contract preserves the product version and verifies both outputs before returning them', async t => {
  const value = await context(t, true)
  const mock = mockAssembler(value.toolkit)
  const prepared = await assembly.preflight({ root: value.root,
    toolkitOptions: { reference: value.published.reference, platform: 'win32' }, invokeOptions: { spawn: mock.spawn } })
  assert.equal(prepared.reused, true)
  const result = await assembly.assemble(optionsFor(value, mock.spawn))
  assert.deepEqual(mock.calls.map(call => call.args[0]), ['inspect', 'assemble', 'verify'])
  const requestFile = mock.calls[1].args[2]
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  assert.equal(request.schemaVersion, 1)
  assert.equal(request.toolkitVersion, '1.2.0')
  assert.equal(request.edition, 'concept')
  assert.equal(request.mode, 'offline')
  assert.equal(request.authority, 'self-built')
  assert.equal(request.identityStore, path.join(value.root, 'local/self-build-identity.json'))
  assert.equal(Object.hasOwn(request, 'signingIdentity'), false)
  assert.equal(Object.hasOwn(request, 'publicConfiguration'), false)
  assert.ok([request.toolkitDirectory, request.outputDirectory, request.identityStore,
    ...Object.values(request.payloads)].every(file => path.isAbsolute(file)))
  assert.equal(result.result.productVersion, '9.4.2')
  assert.equal(result.result.schemaVersion, 1)
  assert.equal(result.result.toolkitManifestSha256, u.sha256(path.join(value.toolkit.directory, 'toolkit-manifest.json')))
  assert.equal(result.result.issuerKeyId, result.result.publicIdentity.id)
  assert.equal(result.result.issuerFingerprint, u.hash(JSON.stringify(result.result.publicIdentity)))
  assert.equal(result.toolkit.toolkitVersion, '1.2.0')
  assert.equal(result.toolkit.authority, 'self-built')
  assert.equal(result.resultSha256, u.sha256(result.resultFile))
  assert.equal(result.retainedInputs.length, 4)
  for (const retained of result.retainedInputs) {
    assert.equal(retained.sha256, u.sha256(retained.file))
    assert.equal(retained.path.startsWith('inputs/' + retained.architecture + '/'), true)
  }
  assert.deepEqual(mock.calls[2].args, ['verify', '--toolkit', value.toolkit.directory, '--result', result.resultFile])
  for (const item of result.installers) {
    assert.equal(item.authority, 'self-built')
    assert.equal(item.sha256, u.sha256(item.path))
    assert.equal(u.peInfo(fs.readFileSync(item.path)).arch, item.architecture)
  }
  for (const item of value.payloads) assert.equal(u.sha256(item.path), item.manifest.archive.sha256)
})

test('assembly forwards workspace installation defaults instead of leaving them inside the binary toolkit', async t => {
  const value = await context(t, true, true)
  const configuration = { schemaVersion: 1, edition: 'concept', options: { autoLaunch: true, usageTracking: false } }
  fs.mkdirSync(path.join(value.root, 'maintenance'), { recursive: true })
  fs.writeFileSync(path.join(value.root, 'maintenance/installation-configuration.json'), JSON.stringify(configuration))
  const mock = mockAssembler(value.toolkit)
  const assembled = await assembly.assemble(optionsFor(value, mock.spawn))
  const request = JSON.parse(fs.readFileSync(mock.calls[0].args[2], 'utf8'))
  assert.deepEqual(request.installationConfiguration, configuration)
  assert.equal(assembled.retainedInputs.length, 5)
  assert.equal(assembled.result.installationConfigurationSha256, u.hash(Buffer.from('{"edition":"concept","options":{"autoLaunch":true,"usageTracking":false},"schemaVersion":1}\n')))
  const collected = collect(value, assembled, 'custom-defaults')
  const retained = collected.manifest.artifacts.find(file => file.file === 'inputs/installation-configuration.json')
  assert.equal(retained.sha256, assembled.result.installationConfigurationSha256)
  assert.equal(fs.readFileSync(path.join(collected.directory, retained.file), 'utf8'), '{"edition":"concept","options":{"autoLaunch":true,"usageTracking":false},"schemaVersion":1}\n')
  assembly.verifyCollected(assembled, collected.directory, { spawn: mock.spawn })
})

test('custom defaults require a compatible pinned binary before compilation or assembly', async t => {
  const value = await context(t)
  fs.mkdirSync(path.join(value.root, 'maintenance'), { recursive: true })
  fs.writeFileSync(path.join(value.root, 'maintenance/installation-configuration.json'), JSON.stringify({ schemaVersion: 1, edition: 'concept', options: { autoLaunch: true } }))
  const mock = mockAssembler(value.toolkit)
  await assert.rejects(assembly.preflight({ root: value.root,
    toolkitOptions: { reference: value.published.reference, platform: 'win32' }, invokeOptions: { spawn: mock.spawn } }), /compatible toolkit/)
  assert.deepEqual(mock.calls.map(call => call.args[0]), ['inspect'])
})

test('configuration changes and missing or substituted result evidence prevent delivery', async t => {
  const value = await context(t, true, true)
  const file = path.join(value.root, 'maintenance/installation-configuration.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = JSON.stringify({ schemaVersion: 1, edition: 'concept', options: { autoLaunch: true } })
  for (const [name, hooks] of [
    ['changed-source', { assemble() { fs.appendFileSync(file, '\n') } }],
    ['changed-before-verification', { verify() { fs.appendFileSync(file, '\n') } }],
    ['missing-result', { assemble({ result }) { delete result.installationConfigurationSha256 } }],
    ['different-result', { assemble({ result }) { result.installationConfigurationSha256 = '0'.repeat(64) } }],
    ['different-verification', { verify({ verified, respond }) { return respond({ ...verified, installationConfigurationSha256: '0'.repeat(64) }) } }],
    ['missing-retained', { assemble({ request }) { fs.unlinkSync(path.join(request.outputDirectory, 'inputs/installation-configuration.json')) } }],
    ['changed-retained', { assemble({ request }) { fs.appendFileSync(path.join(request.outputDirectory, 'inputs/installation-configuration.json'), '\n') } }],
  ]) {
    fs.writeFileSync(file, original)
    const mock = mockAssembler(value.toolkit, hooks)
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, name))))
  }
})

test('detailed assembly evidence must identify the pinned toolkit and a matching public signing identity', async t => {
  const value = await context(t, true)
  for (const [name, change] of [
    ['missing-schema', result => { delete result.schemaVersion }],
    ['schema', result => { result.schemaVersion = 2 }],
    ['toolkit-manifest', result => { result.toolkitManifestSha256 = '0'.repeat(64) }],
    ['fingerprint', result => { result.issuerFingerprint = '0'.repeat(64) }],
    ['missing-public-identity', result => { delete result.publicIdentity }],
    ['identity-id', result => { result.publicIdentity.id = 'different-local-identity' }],
    ['key-type', result => { result.publicIdentity.publicKey.kty = 'RSA' }],
    ['key-curve', result => { result.publicIdentity.publicKey.crv = 'X25519' }],
    ['key-bytes', result => { result.publicIdentity.publicKey.x = 'not-a-public-key' }],
    ['noncanonical-key', result => { result.publicIdentity.publicKey.x = 'A'.repeat(42) + 'B' }],
    ['private-key', result => { result.publicIdentity.publicKey.d = 'private-key-material' }],
    ['private-result-field', result => { result.privateKey = 'private-key-material' }],
    ['private-artifact-field', result => { result.artifacts[0].privateKey = 'private-key-material' }],
  ]) await t.test(name, async () => {
    const mock = mockAssembler(value.toolkit, { assemble({ result }) { change(result) } })
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, name))))
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['assemble'])
  })
  const mock = mockAssembler(value.toolkit, { assemble({ result }) {
    const { id, publicKey } = result.publicIdentity
    result.publicIdentity = { publicKey: { x: publicKey.x, kty: publicKey.kty, crv: publicKey.crv }, id }
  } })
  const result = await assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, 'reordered-key')))
  const { id, publicKey } = result.result.publicIdentity
  assert.equal(result.result.issuerFingerprint, u.hash(JSON.stringify({
    id, publicKey: { crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x },
  })))
  assert.equal(mock.calls.at(-1).args[0], 'verify')
})

test('detailed result JSON accepts the contract size range and rejects more than four MiB', async t => {
  const value = await context(t, true)
  for (const [name, size, allowed] of [['within-limit', 2 * 1024 * 1024, true], ['over-limit', 4 * 1024 * 1024 + 1, false]]) {
    const mock = mockAssembler(value.toolkit)
    const spawn = (executable, args, options) => {
      const response = mock.spawn(executable, args, options)
      if (args[0] === 'assemble') {
        const { resultFile } = JSON.parse(response.stdout)
        fs.appendFileSync(resultFile, ' '.repeat(size - fs.statSync(resultFile).size))
      }
      return response
    }
    const promise = assembly.assemble(optionsFor(value, spawn, path.join(value.root, name)))
    if (allowed) {
      const result = await promise
      assert.equal(fs.statSync(result.resultFile).size, size)
      assert.equal(result.resultSha256, u.sha256(result.resultFile))
    } else await assert.rejects(promise, /size limit/)
  }
})

test('assembly rejects a child response pointing outside its requested result location', async t => {
  const value = await context(t, true)
  for (const [name, change] of [
    ['schema', response => { response.schemaVersion = 2 }],
    ['directory', response => { response.outputDirectory = value.root }],
    ['result-file', response => { response.resultFile = path.join(value.root, 'other-result.json') }],
  ]) {
    const mock = mockAssembler(value.toolkit, { assemble({ response }) { change(response) } })
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, name))), /result location/)
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['assemble'])
  }
})

test('assembly never returns installers after a failed verification result or process', async t => {
  const value = await context(t, true)
  for (const [name, verify] of [
    ['not-verified', ({ verified, respond }) => respond({ ...verified, verified: false })],
    ['wrong-issuer', ({ verified, respond }) => respond({ ...verified, issuerKeyId: 'different-local-identity' })],
    ['wrong-fingerprint', ({ verified, respond }) => respond({ ...verified, issuerFingerprint: '0'.repeat(64) })],
    ['wrong-authority', ({ verified, respond }) => respond({ ...verified, authority: 'official' })],
    ['process-failure', () => ({ status: 9, stderr: 'fixture verifier rejected the binary' })],
  ]) {
    const mock = mockAssembler(value.toolkit, { verify })
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, name))))
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['assemble', 'verify'])
  }
})

test('verification must attest the same artifact inventory as the saved assembly result', async t => {
  const value = await context(t, true)
  const mock = mockAssembler(value.toolkit, { verify({ request, verified, respond }) {
    verified.artifacts = verified.artifacts.map(item => {
      const alternate = { ...item, path: 'different-' + item.path }
      fs.copyFileSync(path.join(request.outputDirectory, item.path), path.join(request.outputDirectory, alternate.path))
      return alternate
    })
    return respond(verified)
  } })
  await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn)), /verification|changed|match|inventory/i)
})

test('verification cannot replace installer bytes and return an updated digest for stale assembly evidence', async t => {
  const value = await context(t, true)
  const mock = mockAssembler(value.toolkit, { verify({ request, verified, respond }) {
    verified.artifacts = structuredClone(verified.artifacts)
    const item = verified.artifacts[0]
    const file = path.join(request.outputDirectory, item.path)
    fs.appendFileSync(file, 'changed during verification')
    item.size = fs.statSync(file).size
    item.sha256 = u.sha256(file)
    return respond(verified)
  } })
  await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn)), /verification|changed|match|inventory/i)
})

test('verification rejects changes to the saved result even when its original response remains valid', async t => {
  const value = await context(t, true)
  const mock = mockAssembler(value.toolkit, { verify({ resultFile, verified, respond }) {
    fs.appendFileSync(resultFile, '\n')
    return respond(verified)
  } })
  await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn)), /changed during verification/)
})

test('input changes during assembly or verification prevent returning a deliverable', async t => {
  for (const timing of ['assemble', 'verify']) await t.test(timing, async sub => {
    const value = await context(sub, true)
    const hooks = { [timing]() { fs.appendFileSync(value.payloads[1].manifestPath, '\n') } }
    const mock = mockAssembler(value.toolkit, hooks)
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn)), /inputs changed/)
    assert.deepEqual(mock.calls.map(call => call.args[0]), timing === 'assemble' ? ['assemble'] : ['assemble', 'verify'])
  })
})

test('configuration appearing during assembly or verification prevents returning a deliverable', async t => {
  for (const timing of ['assemble', 'verify']) await t.test(timing, async sub => {
    const value = await context(sub, true)
    const mock = mockAssembler(value.toolkit, { [timing]() {
      const file = path.join(value.root, 'maintenance/installation-configuration.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, edition: 'concept', options: { autoLaunch: true } }))
    } })
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn)), /configuration changed/)
    assert.deepEqual(mock.calls.map(call => call.args[0]), timing === 'assemble' ? ['assemble'] : ['assemble', 'verify'])
  })
})

test('an existing installer directory or assembly request is preserved without invoking the toolkit', async t => {
  const value = await context(t, true)
  for (const name of ['directory', 'request']) {
    const output = path.join(value.root, name)
    fs.mkdirSync(output)
    const existing = name === 'directory' ? path.join(output, 'installers') : path.join(output, 'assembly-request.json')
    if (name === 'directory') fs.mkdirSync(existing)
    else fs.writeFileSync(existing, 'existing request')
    const mock = mockAssembler(value.toolkit)
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, output)), /already exists|EEXIST/)
    assert.equal(mock.calls.length, 0)
    assert.equal(fs.existsSync(existing), true)
    if (name === 'request') assert.equal(fs.readFileSync(existing, 'utf8'), 'existing request')
  }
})

test('assembly preserves byte-identical inputs and rejects missing, changed or linked retained copies', async t => {
  const value = await context(t, true)
  for (const [name, mutate] of [
    ['missing-manifest', directory => fs.unlinkSync(path.join(directory, 'inputs/x64/application.manifest.json'))],
    ['changed-manifest', directory => fs.appendFileSync(path.join(directory, 'inputs/x64/application.manifest.json'), '\n')],
    ['changed-archive', directory => fs.appendFileSync(path.join(directory, 'inputs/arm64', value.payloads[1].manifest.archive.file), 'changed')],
    ['linked-input-directory', directory => {
      const original = path.join(directory, 'inputs/arm64')
      const moved = path.join(directory, 'arm64-retained-original')
      fs.renameSync(original, moved)
      fs.symlinkSync(moved, original, 'junction')
    }],
  ]) await t.test(name, async () => {
    const mock = mockAssembler(value.toolkit, { assemble({ request }) { mutate(request.outputDirectory) } })
    await assert.rejects(assembly.assemble(optionsFor(value, mock.spawn, path.join(value.root, name))))
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['assemble'])
  })
})

test('collected candidates preserve nested artifact paths and can be reverified from their copied inputs', async t => {
  const value = await context(t, true)
  const mock = mockAssembler(value.toolkit, { assemble({ request, result }) {
    for (const item of result.artifacts) {
      const original = path.join(request.outputDirectory, item.path)
      item.path = 'installers/' + item.architecture + '/' + item.path
      const destination = path.join(request.outputDirectory, ...item.path.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(original, destination)
    }
  } })
  const assembled = await assembly.assemble(optionsFor(value, mock.spawn))
  const collected = collect(value, assembled, 'independent')
  for (const item of assembled.result.artifacts) {
    const file = path.join(collected.directory, ...item.path.split('/'))
    assert.equal(u.sha256(file), item.sha256)
    assert.equal(collected.files.find(record => record.file === item.path).role, 'offline-installer')
  }
  assert.equal(collected.files.filter(item => item.role === 'assembly-input').length, 4)
  for (const item of assembled.retainedInputs) assert.equal(u.sha256(path.join(collected.directory, ...item.path.split('/'))), item.sha256)
  fs.renameSync(path.dirname(assembled.resultFile), path.dirname(assembled.resultFile) + '-unavailable')
  fs.renameSync(path.join(value.root, 'source'), path.join(value.root, 'source-unavailable'))
  const checked = assembly.verifyCollected(assembled, collected.directory, { spawn: mock.spawn }, collected)
  assert.deepEqual(checked.inputs, assembled.result.inputs)
  assert.deepEqual(checked.artifacts, assembled.result.artifacts)
  assert.equal(mock.calls.at(-1).args[4], path.join(collected.directory, 'assembly-result.json'))
})

test('collected candidate verification rejects changed result, binary or retained input bytes', async t => {
  const value = await context(t, true)
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler(value.toolkit).spawn))
  for (const [name, mutate] of [
    ['result', directory => fs.appendFileSync(path.join(directory, 'assembly-result.json'), '\n')],
    ['installer', directory => fs.appendFileSync(path.join(directory, assembled.result.artifacts[0].path), 'changed')],
    ['retained-manifest', directory => fs.appendFileSync(path.join(directory, 'inputs/x64/application.manifest.json'), '\n')],
    ['retained-archive', directory => fs.appendFileSync(path.join(directory, 'inputs/arm64', value.payloads[1].manifest.archive.file), 'changed')],
    ['missing-input', directory => fs.unlinkSync(path.join(directory, 'inputs/arm64/application.manifest.json'))],
    ['linked-input', directory => {
      const original = path.join(directory, 'inputs/x64')
      const moved = path.join(directory, 'x64-retained-original')
      fs.renameSync(original, moved)
      fs.symlinkSync(moved, original, 'junction')
    }],
  ]) await t.test(name, () => {
    const collected = collect(value, assembled, name)
    mutate(collected.directory)
    const mock = mockAssembler(value.toolkit)
    assert.throws(() => assembly.verifyCollected(assembled, collected.directory, { spawn: mock.spawn }))
    if (name === 'result') assert.equal(mock.calls.length, 0)
  })
})

test('collected verification cannot change authority, issuer, inventory or result evidence', async t => {
  const value = await context(t, true)
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler(value.toolkit).spawn))
  for (const [name, verify] of [
    ['failure', ({ verified, respond }) => respond({ ...verified, verified: false })],
    ['authority', ({ verified, respond }) => respond({ ...verified, authority: 'official' })],
    ['issuer', ({ verified, respond }) => respond({ ...verified, issuerKeyId: 'another-local-identity' })],
    ['fingerprint', ({ verified, respond }) => respond({ ...verified, issuerFingerprint: '0'.repeat(64) })],
    ['result-drift', ({ resultFile, verified, respond }) => {
      fs.appendFileSync(resultFile, '\n')
      return respond(verified)
    }],
    ['inventory', ({ resultFile, verified, respond }) => {
      verified.artifacts = verified.artifacts.map(item => {
        const changed = { ...item, path: 'other-' + item.path }
        fs.copyFileSync(path.join(path.dirname(resultFile), item.path), path.join(path.dirname(resultFile), changed.path))
        return changed
      })
      return respond(verified)
    }],
  ]) await t.test(name, () => {
    const collected = collect(value, assembled, name)
    const mock = mockAssembler(value.toolkit, { verify })
    assert.throws(() => assembly.verifyCollected(assembled, collected.directory, { spawn: mock.spawn }))
    assert.deepEqual(mock.calls.map(call => call.args[0]), ['verify'])
  })
})

test('collected verification retains the collection identity before and during binary invocation', async t => {
  const value = await context(t, true)
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler(value.toolkit).spawn))
  for (const role of ['application-payload', 'application-payload-manifest', 'portable']) {
    for (const timing of ['before', 'during']) await t.test(role + '-' + timing, () => {
      const collected = collect(value, assembled, role + '-' + timing, 'complete')
      const file = path.join(collected.directory, collected.files.find(item => item.role === role).file)
      const mutate = () => fs.appendFileSync(file, 'changed')
      const mock = mockAssembler(value.toolkit, timing === 'during' ? { verify({ verified, respond }) {
        mutate(); return respond(verified)
      } } : {})
      if (timing === 'before') mutate()
      assert.throws(() => assembly.verifyCollected(assembled, collected.directory, { spawn: mock.spawn }, collected), /inputs changed/)
      assert.equal(mock.calls.length, timing === 'before' ? 0 : 1)
    })
  }
})
