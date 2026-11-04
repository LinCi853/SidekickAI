'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assembly = require('./assemble-application.cjs')
const distribution = require('./build-distribution.cjs')
const toolkitApi = require('./distribution-toolkit.cjs')
const u = require('./build-utils.cjs')
const { pe } = require('./test-fixtures/application-runtime.cjs')
const { fixtureRoot, writeToolkit, createPayloads, mockAssembler } =
  require('./test-fixtures/distribution-toolkit.cjs')

const OFFICIAL_KEY_ID = 'admin_c80c9c3f5a39429ba71bea5db45ff3cc'

function copy(source, destination, relative) {
  const file = path.join(destination, ...relative.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.copyFileSync(path.join(source, ...relative.split('/')), file)
}

async function context(t, { payloads = false, descriptor = true, configuration = null } = {}) {
  const directory = fixtureRoot(t)
  const root = path.join(directory, 'workspace with spaces & punctuation')
  const published = writeToolkit(path.join(directory, 'published'))
  t.mock.method(toolkitApi, 'prepareToolkit', published.toolkit.prepareToolkit)
  const toolkit = await toolkitApi.prepareToolkit(root, { reference: published.reference })
  copy(path.resolve(__dirname, '..'), root, 'packages/product-contract/manifest.json')
  copy(path.resolve(__dirname, '..'), root, 'contracts/installation-contract.json')
  if (descriptor) copy(path.resolve(__dirname, '..'), root, 'contracts/distribution-product.json')
  if (configuration) {
    fs.mkdirSync(path.join(root, 'contracts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'contracts/installation-configuration.json'), JSON.stringify(configuration))
  }
  const assembledPayloads = payloads ? await createPayloads(path.join(root, 'source')) : undefined
  return { directory, root, published, toolkit, payloads: assembledPayloads }
}

function optionsFor(value, spawn, output = path.join(value.root, 'candidate'), extra = {}) {
  return { root: value.root, output, payloads: value.payloads, edition: 'concept', productVersion: '9.4.2',
    toolkit: value.toolkit, invokeOptions: { spawn }, ...extra }
}

function collect(value, assembled, name, mode = 'installer') {
  fs.mkdirSync(path.join(value.root, 'packages/product-contract'), { recursive: true })
  fs.mkdirSync(path.join(value.root, 'contracts'), { recursive: true })
  fs.writeFileSync(path.join(value.root, 'package.json'), JSON.stringify({ version: '9.4.2' }))
  fs.writeFileSync(path.join(value.root, 'product-edition.json'), JSON.stringify({ edition: 'concept' }))
  fs.writeFileSync(path.join(value.root, 'packages/product-contract/manifest.json'), JSON.stringify({ editions: { concept: {} } }))
  fs.writeFileSync(path.join(value.root, 'contracts/shared-source.json'), JSON.stringify({ schemaVersion: 1, files: [] }))
  const output = path.join(value.root, 'collected-' + name)
  fs.mkdirSync(output)
  const portable = {}
  if (mode === 'complete') {
    for (const architecture of ['x64', 'arm64']) {
      const file = path.join(value.root, `portable-${architecture}.zip`)
      fs.writeFileSync(file, `fixture portable archive ${architecture}`)
      portable[architecture] = { arch: architecture, path: file }
    }
  }
  return distribution.collectCandidates({ edition: 'concept', version: '9.4.2', mode,
    ...(mode === 'complete' ? { portable: Object.values(portable) } : {}),
    architectures: ['x64', 'arm64'], payloads: value.payloads, assembly: assembled,
    launch: { attempted: false, reason: 'not attempted in fixture' },
    inputs: { fingerprint: 'fixture-source-inputs', entries: [] } }, output, value.root)
}

function identityOf(result) {
  return {
    edition: result.edition, productVersion: result.productVersion,
    inputs: structuredClone(result.inputs), productId: result.productId,
    productDescriptorSha256: result.productDescriptorSha256,
    ...(result.installationConfigurationSha256 === undefined
      ? {} : { installationConfigurationSha256: result.installationConfigurationSha256 }),
  }
}

function cloneOutput(root, result, name) {
  const output = path.join(root, 'clone-' + name)
  fs.mkdirSync(output)
  for (const item of result.artifacts) {
    fs.mkdirSync(path.dirname(path.join(output, item.path)), { recursive: true })
    fs.copyFileSync(path.join(root, 'candidate/installers', item.path), path.join(output, item.path))
  }
  return output
}

test('binary invocation preserves argv boundaries, hides the window and parses the final JSON line', async t => {
  const { toolkit } = await context(t)
  const argument = 'C:/build path/contains & shell punctuation/package'
  let call
  const value = assembly.invoke(toolkit, ['assemble', '--package-dir', argument, '--edition', 'concept'], {
    spawn(executable, args, options) {
      call = { executable, args, options }
      return { status: 0, stderr: '', stdout: 'diagnostic output\r\n{"verified":true}\r\n' }
    },
  })
  assert.deepEqual(value, { verified: true })
  assert.equal(call.executable, path.join(toolkit.directory, 'bin/AppLifecycleToolkit.exe'))
  assert.deepEqual(call.args, ['assemble', '--package-dir', argument, '--edition', 'concept'])
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
  ]) assert.throws(() => assembly.invoke(toolkit, ['build'], { spawn: () => result }))
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
    value => { value.toolkitVersion += '-foreign' },
    value => { value.archive.size++ },
    value => { value.archive.sha256 = '0'.repeat(64) },
  ]) {
    const reference = structuredClone(require('../contracts/distribution-toolkit.json'))
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
    const mutate = () => fs.appendFileSync(path.join(toolkit.directory, 'README.md'), 'changed')
    if (timing === 'before') mutate()
    assert.throws(() => assembly.invoke(toolkit, ['build'], { spawn() {
      invoked = true
      mutate()
      return { status: 0, stdout: '{"verified":true}' }
    } }), /pinned identity/)
    assert.equal(invoked, timing === 'during')
  })
})

test('input identity binds both real application archives and their exact external manifests', async t => {
  const value = await context(t, { payloads: true })
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
  for (const payloads of [[], [value.payloads[0], value.payloads[0]]]) {
    assert.throws(() => assembly.inputIdentity(payloads, 'concept', '9.4.2'), /architectures/)
  }
  assert.throws(() => assembly.inputIdentity(value.payloads, 'community', '9.4.2'), /concept/)
  assert.throws(() => assembly.inputIdentity(value.payloads, 'concept', '1.2.0'), /identity/)
})

test('input validation rejects manifest identity drift and archive replacement', async t => {
  const value = await context(t, { payloads: true })
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
  const value = await context(t, { payloads: true })
  for (const payload of value.payloads) {
    fs.appendFileSync(payload.manifestPath, ' '.repeat(2 * 1024 * 1024 - fs.statSync(payload.manifestPath).size))
  }
  const identity = assembly.inputIdentity(value.payloads, 'concept', '9.4.2')
  for (const payload of value.payloads) assert.equal(identity.inputs[payload.architecture].manifestSha256, u.sha256(payload.manifestPath))
})

test('assembly result acceptance binds authority, application identity, inputs and both installer architectures', async t => {
  const value = await context(t, { payloads: true })
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler().spawn))
  const identity = identityOf(assembled.result)
  for (const [name, change, expected] of [
    ['interface', result => { result.interfaceVersion = 2 }],
    ['toolkit-version', result => { result.toolkitVersion = '0.1.6' }],
    ['edition', result => { result.edition = 'community' }],
    ['product-version', result => { result.productVersion = '1.2.0' }],
    ['authority', result => { result.authority = 'official' }],
    ['domain', result => { result.domain = 'official:other' }],
    ['mode', result => { result.mode = 'online' }],
    ['issuer-empty', result => { result.issuerKeyId = '' }],
    ['issuer-spaces', result => { result.issuerKeyId = 'identity with spaces' }],
    ['fingerprint-missing', result => { delete result.issuerFingerprint }],
    ['fingerprint-format', result => { result.issuerFingerprint = 'not-a-fingerprint' }],
    ['inputs-hash', result => { result.inputs.arm64.manifestSha256 = '0'.repeat(64) }],
    ['inputs-missing', result => { delete result.inputs.x64 }],
    ['artifact-missing', result => { result.artifacts.pop() }],
    ['artifact-duplicate', result => { result.artifacts.push(structuredClone(result.artifacts[0])) }],
    ['artifact-arch', result => { result.artifacts[1].architecture = 'x64' }],
    ['artifact-role', result => { result.artifacts[0].role = 'online-bootstrap' }],
    ['artifact-size', result => { result.artifacts[0].size += 1 }],
    ['artifact-sha', result => { result.artifacts[0].sha256 = '0'.repeat(64) }],
    ['artifact-zero', result => { result.artifacts[0].size = 0 }],
  ]) await t.test(name, () => {
    const result = structuredClone(assembled.result)
    change(result)
    const output = cloneOutput(value.root, assembled.result, name)
    assert.throws(() => assembly.validateResult(result, value.toolkit, output, identity), expected)
  })
  const swapped = structuredClone(assembled.result)
  const output = cloneOutput(value.root, assembled.result, 'swapped')
  const x64 = path.join(output, swapped.artifacts[0].path)
  fs.writeFileSync(x64, pe('arm64'))
  swapped.artifacts[0].sha256 = u.sha256(x64)
  swapped.artifacts[0].size = fs.statSync(x64).size
  assert.throws(() => assembly.validateResult(swapped, value.toolkit, output, identity), /bytes/)
})

test('self-built assembly runs build, verify-package-spec and assemble per architecture', async t => {
  const value = await context(t, { payloads: true })
  const runner = mockAssembler()
  const assembled = await assembly.assemble(optionsFor(value, runner.spawn))
  assert.equal(assembled.result.authority, 'self-built')
  assert.equal(assembled.result.domain, 'self-built')
  assert.equal(assembled.result.issuerKeyId, 'self-built')
  assert.equal(assembled.result.toolkitVersion, '0.1.7')
  assert.deepEqual(assembled.installers.map(item => item.architecture), ['x64', 'arm64'])
  for (const item of assembled.installers) {
    assert.equal(path.basename(item.path), 'SidekickAI-Setup-9.4.2-' + item.architecture + '-self-built.exe')
    assert.equal(item.authority, 'self-built')
    assert.equal(u.sha256(item.path), item.sha256)
    assert.equal(u.peInfo(fs.readFileSync(item.path)).arch, item.architecture)
  }
  assert.deepEqual(runner.calls.map(call => call.args[0]),
    ['build', 'verify-package-spec', 'assemble', '--check', 'build', 'verify-package-spec', 'assemble'])
  for (const call of runner.calls.filter(item => item.args[0] !== '--check')) {
    assert.equal(call.executable, path.join(value.toolkit.directory, 'bin/AppLifecycleToolkit.exe'))
    assert.equal(call.options.shell, false)
    assert.equal(call.args.includes('--key-file'), false)
  }
  const checks = assembled.result.artifacts.map(item => item.check)
  assert.deepEqual(checks, [
    { attempted: true, ok: true, domain: 'self-built', exitCode: 0 },
    { attempted: false, ok: false, domain: 'self-built', reason: 'architecture-mismatch' },
  ])
  assert.equal(assembled.resultSha256, u.sha256(assembled.resultFile))
  assert.equal(assembled.retainedInputs.length, 5)
  assert.equal(assembled.toolkit.toolkitVersion, '0.1.7')
  assert.equal(assembled.toolkit.authority, 'self-built')
})

test('a key file selects the official domain without leaking private material', async t => {
  const value = await context(t, { payloads: true })
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const keyFile = path.join(value.directory, 'publication-key.json')
  fs.writeFileSync(keyFile, JSON.stringify({ schemaVersion: 1, keyId: OFFICIAL_KEY_ID, privateKey: jwk }))
  const runner = mockAssembler({ domain: 'official:' + OFFICIAL_KEY_ID })
  const assembled = await assembly.assemble(optionsFor(value, runner.spawn, undefined, { keyFile }))
  assert.equal(assembled.result.authority, 'official:' + OFFICIAL_KEY_ID)
  assert.equal(assembled.result.domain, 'official:' + OFFICIAL_KEY_ID)
  assert.equal(assembled.result.issuerKeyId, OFFICIAL_KEY_ID)
  assert.equal(assembled.result.publicIdentity.id, OFFICIAL_KEY_ID)
  assert.equal(path.basename(assembled.installers[0].path),
    'SidekickAI-Setup-9.4.2-x64-official.exe')
  assert.deepEqual(runner.calls.map(call => call.args[0]),
    ['build', 'verify-package-spec', 'assemble', '--check', 'build', 'verify-package-spec', 'assemble'])
  for (const call of runner.calls.filter(item => item.args[0] !== '--check')) {
    assert.equal(call.args.includes('--key-file'), true, call.args[0])
    assert.equal(fs.existsSync(call.args[call.args.indexOf('--key-file') + 1]), false,
      'Temporary key files must be removed after each step')
  }
  assert.ok(fs.existsSync(keyFile), 'The original key file is never moved or removed')
  const evidence = fs.readFileSync(assembled.resultFile, 'utf8')
  assert.equal(evidence.includes(jwk.d), false, 'Private key material must not enter result evidence')
  for (const item of assembled.result.artifacts)
    assert.equal(fs.readFileSync(path.join(path.dirname(assembled.resultFile), item.path)).includes(jwk.d), false)
})

test('official key sets select one key without assuming a literal id', async t => {
  const value = await context(t, { payloads: true })
  const jwk = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  const first = 'admin_' + 'a'.repeat(32)
  const second = 'admin_' + 'b'.repeat(32)
  const keyFile = path.join(value.directory, 'publication-keys.json')
  const writeSet = (document) => fs.writeFileSync(keyFile, JSON.stringify(document))
  const entries = [{ id: first, privateKey: jwk() }, { id: second, privateKey: jwk() }]
  const assembleWith = async (name, extra, domainKey) => {
    const runner = mockAssembler({ domain: 'official:' + domainKey })
    return assembly.assemble(optionsFor(value, runner.spawn, path.join(value.root, name), { keyFile, ...extra }))
  }

  writeSet({ formatVersion: 1, adminKeys: entries })
  await assert.rejects(assembly.assemble(optionsFor(value, mockAssembler().spawn,
    path.join(value.root, 'ambiguous'), { keyFile })), /多把 admin 钥/)
  const explicit = await assembleWith('explicit', { keyId: second }, second)
  assert.equal(explicit.result.issuerKeyId, second)
  assert.equal(explicit.result.domain, 'official:' + second)

  writeSet({ formatVersion: 1, adminKeyId: second, adminKeys: entries })
  const designated = await assembleWith('designated', {}, second)
  assert.equal(designated.result.issuerKeyId, second)

  writeSet({ formatVersion: 1,
    adminKeys: [{ ...entries[0] }, { ...entries[1], active: true }] })
  const active = await assembleWith('active', {}, second)
  assert.equal(active.result.issuerKeyId, second)

  writeSet({ formatVersion: 1, adminKeys: entries })
  await assert.rejects(assembly.assemble(optionsFor(value, mockAssembler().spawn,
    path.join(value.root, 'unknown'), { keyFile, keyId: 'admin_' + 'c'.repeat(32) })), /缺少 admin_cccc/)
  await assert.rejects(assembly.assemble(optionsFor(value, mockAssembler().spawn,
    path.join(value.root, 'bad-id'), { keyFile, keyId: 'admin/with/slash' })), /id 格式不受支持/)

  writeSet({ formatVersion: 1, adminKeys: [entries[0]] })
  const single = await assembleWith('single', {}, first)
  assert.equal(single.result.issuerKeyId, first)
  assert.equal(single.result.domain, 'official:' + first)
})

test('verify-package-spec must attest the requested domain before assembly', async t => {
  const value = await context(t, { payloads: true })
  const runner = mockAssembler({ verify({ packageDir, respond }) {
    return respond({ packageDir, domain: 'official:foreign', form: 'offline', checks: [], configuration: {} })
  } })
  await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn)), /reported official:foreign/)
  assert.deepEqual(runner.calls.map(call => call.args[0]), ['build', 'verify-package-spec'])
})

test('failed build, verification or assembly steps abort the batch without a result', async t => {
  for (const [name, hooks, expected] of [
    ['build', { build: () => ({ status: 9, stderr: 'fixture build rejected the package' }) }, /执行失败/],
    ['verify', { verify: () => ({ status: 9, stderr: 'fixture verifier rejected the package' }) }, /执行失败/],
    ['assemble', { assemble: () => ({ status: 9, stderr: 'fixture assembler rejected the package' }) }, /执行失败/],
  ]) await t.test(name, async () => {
    const value = await context(t, { payloads: true })
    const runner = mockAssembler(hooks)
    await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn, path.join(value.root, name))), expected)
    assert.equal(fs.existsSync(path.join(value.root, name, 'installers/assembly-result.json')), false)
  })
})

test('assembly reports must agree with the written installer bytes and requested architecture', async t => {
  for (const [name, hook] of [
    ['size', ({ outFile, architecture, domain, respond }) => respond({
      outFile, outputBytes: fs.statSync(outFile).size + 1, outputSha256: u.sha256(outFile),
      domain, architectures: [architecture] })],
    ['digest', ({ outFile, architecture, domain, respond }) => respond({
      outFile, outputBytes: fs.statSync(outFile).size, outputSha256: '0'.repeat(64),
      domain, architectures: [architecture] })],
    ['domain', ({ outFile, architecture, respond }) => respond({
      outFile, outputBytes: fs.statSync(outFile).size, outputSha256: u.sha256(outFile),
      domain: 'official:foreign', architectures: [architecture] })],
    ['architecture', ({ outFile, architecture, domain, respond }) => respond({
      outFile, outputBytes: fs.statSync(outFile).size, outputSha256: u.sha256(outFile),
      domain, architectures: [architecture === 'x64' ? 'arm64' : 'x64'] })],
    ['location', ({ outFile, architecture, domain, respond }) => respond({
      outFile: outFile + '.other', outputBytes: fs.statSync(outFile).size,
      outputSha256: u.sha256(outFile), domain, architectures: [architecture] })],
  ]) await t.test(name, async () => {
    const value = await context(t, { payloads: true })
    const runner = mockAssembler({ assemble: hook })
    await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn, path.join(value.root, name))),
      /unexpected installer identity|does not match its report/)
    assert.deepEqual(runner.calls.map(call => call.args[0]),
      ['build', 'verify-package-spec', 'assemble'])
  })
})

test('the launch gate rejects installers that report blocking self-check output', async t => {
  for (const [name, result, expected] of [
    ['untrusted', { status: 0, stdout: 'domain: self-built\nPACKAGE_UNTRUSTED\n', stderr: '' }, /PACKAGE_UNTRUSTED/],
    ['blocked', { status: 0, stdout: 'domain: self-built\n[阻止] 安装源不可信\n', stderr: '' }, /阻塞/],
    ['process', { status: 9, stdout: '', stderr: 'fixture self-check failed' }, /自检失败/],
  ]) await t.test(name, async () => {
    const value = await context(t, { payloads: true })
    const runner = mockAssembler({ check: () => result })
    await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn, path.join(value.root, name))), expected)
    assert.equal(fs.existsSync(path.join(value.root, name, 'installers/assembly-result.json')), false)
  })
})

test('an existing installer directory is preserved without invoking the toolkit', async t => {
  const value = await context(t, { payloads: true })
  const output = path.join(value.root, 'existing')
  fs.mkdirSync(path.join(output, 'installers'), { recursive: true })
  const runner = mockAssembler()
  await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn, output)), /already exists/)
  assert.equal(runner.calls.length, 0)
  assert.equal(fs.existsSync(path.join(output, 'installers')), true)
})

test('application manifests project the product descriptor and installation defaults', async t => {
  const value = await context(t, { payloads: true,
    configuration: { schemaVersion: 1, edition: 'concept', options: { autoLaunch: true, usageTracking: false } } })
  let manifest
  const runner = mockAssembler({ build({ args }) {
    manifest = JSON.parse(fs.readFileSync(args[args.indexOf('--manifest') + 1], 'utf8'))
  } })
  const assembled = await assembly.assemble(optionsFor(value, runner.spawn))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.app.productId, 'sidekickai')
  assert.equal(manifest.app.edition, 'concept')
  assert.equal(manifest.app.name, '工百窗')
  assert.equal(manifest.app.publisher, 'LinCi853')
  assert.equal(manifest.app.icon, 'resources/product-icon.ico')
  assert.equal(manifest.app.entry, 'SidekickAI.exe')
  assert.equal(manifest.app.identityCarrier, 'electron-asar')
  assert.equal(manifest.productVersion, '9.4.2')
  assert.deepEqual(manifest.payload.packages[0].requiredFiles,
    require('./application-packaging.cjs').REQUIRED_RUNTIME_FILES)
  assert.equal(manifest.defaults.directory, 'SidekickAI-Concept')
  assert.deepEqual(manifest.defaults.options, { autoLaunch: true, usageTracking: false })
  assert.equal(manifest.presentation.options.length, 3)
  assert.equal(assembled.result.installationConfigurationSha256, u.hash(Buffer.from(
    '{"edition":"concept","options":{"autoLaunch":true,"usageTracking":false},"schemaVersion":1}\n')))
  assert.equal(assembled.retainedInputs.filter(file => file.path === 'inputs/installation-configuration.json').length, 1)
})

test('changed sources during assembly prevent returning a deliverable', async t => {
  for (const [name, mutate, expected] of [
    ['payload', value => fs.appendFileSync(value.payloads[0].manifestPath, '\n'), /inputs do not match|inputs changed/],
    ['descriptor', value => fs.appendFileSync(path.join(value.root, 'contracts/distribution-product.json'), '\n'),
      /descriptor changed/],
    ['configuration', value => fs.appendFileSync(path.join(value.root, 'contracts/installation-configuration.json'), '\n'),
      /configuration changed/],
  ]) await t.test(name, async () => {
    const value = await context(t, { payloads: true,
      configuration: { schemaVersion: 1, edition: 'concept', options: { autoLaunch: true } } })
    const runner = mockAssembler({ build() { mutate(value) } })
    await assert.rejects(assembly.assemble(optionsFor(value, runner.spawn)), expected)
    assert.ok(runner.calls.filter(call => call.args[0] === 'build').length >= 1)
  })
})

test('collected candidates preserve installer and retained-input identities', async t => {
  const value = await context(t, { payloads: true })
  const runner = mockAssembler()
  const assembled = await assembly.assemble(optionsFor(value, runner.spawn))
  for (const item of assembled.result.artifacts) assert.equal(item.path.includes('/'), false)
  const collected = collect(value, assembled, 'independent')
  for (const item of assembled.result.artifacts) {
    const file = path.join(collected.directory, ...item.path.split('/'))
    assert.equal(u.sha256(file), item.sha256)
    assert.equal(collected.files.find(record => record.file === item.path).role, 'offline-installer')
  }
  assert.equal(collected.files.filter(item => item.role === 'assembly-input').length, 5)
  for (const item of assembled.retainedInputs)
    assert.equal(u.sha256(path.join(collected.directory, ...item.path.split('/'))), item.sha256)
  fs.renameSync(path.dirname(assembled.resultFile), path.dirname(assembled.resultFile) + '-unavailable')
  fs.renameSync(path.join(value.root, 'source'), path.join(value.root, 'source-unavailable'))
  const checked = assembly.verifyCollected(assembled, collected.directory, { spawn: runner.spawn }, collected)
  assert.deepEqual(checked.inputs, assembled.result.inputs)
  assert.deepEqual(checked.artifacts, assembled.result.artifacts)
})

test('collected candidate verification rejects changed result, installer or retained input bytes', async t => {
  const value = await context(t, { payloads: true })
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler().spawn))
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
    const runner = mockAssembler()
    assert.throws(() => assembly.verifyCollected(assembled, collected.directory, { spawn: runner.spawn }))
    if (name === 'result') assert.equal(runner.calls.length, 0)
  })
})

test('collected verification cannot change authority, issuer, inventory or installer bytes', async t => {
  const value = await context(t, { payloads: true })
  const assembled = await assembly.assemble(optionsFor(value, mockAssembler().spawn))
  for (const [name, check] of [
    ['untrusted', () => ({ status: 0, stdout: 'domain: self-built\nPACKAGE_UNTRUSTED\n', stderr: '' })],
    ['blocked', () => ({ status: 0, stdout: 'domain: self-built\n[阻止] 安装源不可信\n', stderr: '' })],
    ['failure', () => ({ status: 9, stdout: '', stderr: 'fixture self-check failed' })],
  ]) await t.test(name, () => {
    const collected = collect(value, assembled, name)
    const runner = mockAssembler({ check })
    assert.throws(() => assembly.verifyCollected(assembled, collected.directory, { spawn: runner.spawn }))
    assert.deepEqual(runner.calls.map(call => call.args[0]), ['--check'])
  })
})
