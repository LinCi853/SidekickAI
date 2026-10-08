'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const distribution = require('./application-distribution.cjs')
const fixture = require('./test-fixtures/distribution-signing.cjs')

test('release channels follow the semantic prerelease stage independently of build metadata', () => {
  const cases = [
    ['0.1.5', 'stable'], ['0.1.5+20261008.001', 'stable'], ['0.1.5+build-beta.3', 'stable'],
    ['0.1.5-alpha+20261008.001', 'alpha'], ['0.1.5-alpha.1+20261008.001', 'alpha'],
    ['0.1.5-beta', 'beta'], ['0.1.5-rc.2', 'rc'],
  ]
  for (const [productVersion, channel] of cases) {
    assert.equal(distribution.releaseChannel(productVersion), channel)
    for (const candidate of ['stable', 'alpha', 'beta', 'rc']) {
      const payload = { protocolVersion: 1, productId: 'sidekickai', edition: 'concept', productVersion, channel: candidate }
      if (candidate === channel) assert.equal(distribution.validatePayload(payload, distribution.PURPOSES.release), payload)
      else assert.throws(() => distribution.validatePayload(payload, distribution.PURPOSES.release), /channel.*version/)
    }
  }
  for (const productVersion of ['01.1.5', '0.1.5-alpha.01', '0.1.5-nightly', '0.1.5-beta-rc', '0.1.5+build..1', '0.1.5\n']) {
    assert.throws(() => distribution.releaseChannel(productVersion), /version/)
  }
})

function temporary(t) {
  const directory = path.resolve(__dirname, '../build/distribution-contract-tests')
  fs.mkdirSync(directory, { recursive: true })
  const root = fs.mkdtempSync(path.join(directory, 'fixture-'))
  t.after(() => {
    assert.ok(root.startsWith(directory + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('runtime and body proofs bind the complete canonical payload to separate signing purposes', () => {
  const signer = fixture.createSigner()
  for (const [kind, payload] of [['runtime', fixture.runtimePayload()], ['body', fixture.bodyPayload()]]) {
    const purpose = distribution.PURPOSES[kind]
    const envelope = distribution.signEnvelope(payload, purpose, signer)
    assert.deepEqual(distribution.verifyEnvelope(envelope, purpose, signer.trust).payload, payload)
    assert.throws(() => distribution.verifyEnvelope(envelope, distribution.PURPOSES.channel, signer.trust), /purpose/)
    assert.throws(() => distribution.verifyEnvelope(envelope, purpose, fixture.createSigner().trust), /trusted/)
    const changed = structuredClone(envelope)
    changed.payload.edition = 'concept'
    assert.throws(() => distribution.verifyEnvelope(changed, purpose, signer.trust), /body mismatch/)
    const substituted = structuredClone(envelope)
    substituted.signature = substituted.signature.slice(0, -8) + 'A'.repeat(8)
    assert.throws(() => distribution.verifyEnvelope(substituted, purpose, signer.trust), /verification|encoding/)
  }
})

test('body inventory rejects mutable data, self references, collisions and mismatched component identities', () => {
  for (const name of ['../source', '/source', 'a\\source', 'C:source', 'a/./source', 'NUL.txt', 'a/source.', 'a/source ']) {
    assert.throws(() => distribution.validateRelativePath(name), /Unsafe/)
  }
  for (const name of ['data/chat.db', 'Data', 'distribution-proof.json', 'body-proof.json']) {
    const payload = fixture.bodyPayload()
    payload.files[0].path = name
    assert.throws(() => distribution.validatePayload(payload, distribution.PURPOSES.body), /body contains/)
  }
  const collision = fixture.bodyPayload()
  collision.files[1].path = 'sidekickai.exe'
  assert.throws(() => distribution.validatePayload(collision, distribution.PURPOSES.body), /Duplicate/)
  for (const field of ['sha256', 'sizeBytes', 'nativeArchitecture', 'proofPath']) {
    const payload = fixture.bodyPayload()
    payload.components[0][field] = field === 'sizeBytes' ? 2 : field === 'sha256' ? 'd'.repeat(64)
      : field === 'nativeArchitecture' ? 'arm64' : 'absent.json'
    assert.throws(() => distribution.validatePayload(payload, distribution.PURPOSES.body), /component|dependency/)
  }
  const wrongArch = fixture.runtimePayload()
  wrongArch.files[0].executableArchitecture = 'arm64'
  assert.throws(() => distribution.validatePayload(wrongArch, distribution.PURPOSES.runtime), /native binary/)
})

test('a controlled local signer must match the public build trust and identity guard', t => {
  const root = temporary(t)
  const signer = fixture.createSigner()
  const privateSet = { formatVersion: 1, instanceId: crypto.randomUUID(),
    adminKeys: [{ id: signer.id, privateKey: signer.privateKey.export({ format: 'jwk' }) }] }
  const advertised = { formatVersion: 1, instanceId: privateSet.instanceId, adminKeys: signer.trust }
  const keysFile = path.join(root, 'signing.json')
  const trustFile = path.join(root, 'trust.json')
  fs.writeFileSync(keysFile, JSON.stringify(privateSet), { mode: 0o600 })
  fs.writeFileSync(trustFile, JSON.stringify(advertised), { mode: 0o600 })
  const env = { SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(signer.trust),
    SIDEKICK_DISTRIBUTION_SIGNING_KEYS_FILE: keysFile, SIDEKICK_DISTRIBUTION_SIGNING_TRUST_FILE: trustFile }
  const loaded = distribution.loadLocalSigner(root, env)
  assert.equal(loaded.id, signer.id)
  const proof = distribution.signEnvelope(fixture.runtimePayload(), distribution.PURPOSES.runtime, loaded)
  assert.equal(proof.payload.nativeArchitecture, 'x64')
  assert.throws(() => distribution.loadLocalSigner(root, { ...env,
    SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(fixture.createSigner().trust) }), /matches/)
  advertised.instanceId = crypto.randomUUID()
  fs.writeFileSync(trustFile, JSON.stringify(advertised))
  assert.throws(() => distribution.loadLocalSigner(root, env), /identity/)
  const privateTrust = [{ ...signer.trust[0], privateKey: privateSet.adminKeys[0].privateKey }]
  assert.throws(() => distribution.publicTrust(root, { SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(privateTrust) }), /Public/)
})

test('inventories are independent of proof files and user data while binding every immutable file', t => {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'app.txt'), 'application')
  fs.writeFileSync(path.join(root, 'distribution-proof.json'), 'proof')
  fs.writeFileSync(path.join(root, 'data', 'notes.txt'), 'personal')
  const files = distribution.fileInventory(root, { exclude: ['distribution-proof.json', 'data'] })
  assert.deepEqual(files.map(file => file.path), ['app.txt'])
  assert.equal(files[0].sha256, distribution.hash(Buffer.from('application')))
  assert.equal(files[0].sizeBytes, 11)
  fs.writeFileSync(path.join(root, 'app.txt'), 'changed')
  assert.notEqual(distribution.fileInventory(root, { exclude: ['distribution-proof.json', 'data'] })[0].sha256, files[0].sha256)
})


test('file inventories classify only verified IL-only managed executables as AnyCPU', t => {
  const root = temporary(t)
  const executable = path.join(__dirname, '../resources/windows/SidekickStartup.exe')
  assert.ok(fs.existsSync(executable), 'The verified startup helper is required')
  const bytes = fs.readFileSync(executable)
  const target = path.join(root, 'managed.exe')
  fs.writeFileSync(target, bytes)
  assert.equal(distribution.fileInventory(root)[0].executableArchitecture, 'anycpu')
  const pe = bytes.readUInt32LE(0x3c), optional = pe + 24
  const clrRva = bytes.readUInt32LE(optional + 96 + 14 * 8)
  let clr = -1
  for (let index = 0; index < bytes.readUInt16LE(pe + 6); index++) {
    const section = optional + bytes.readUInt16LE(pe + 20) + index * 40
    const rva = bytes.readUInt32LE(section + 12)
    const size = bytes.readUInt32LE(section + 16)
    if (clrRva >= rva && clrRva - rva + 20 <= size) clr = bytes.readUInt32LE(section + 20) + clrRva - rva
  }
  assert.ok(clr >= 0)
  for (const flags of [0, 3, 0x20001]) {
    const altered = Buffer.from(bytes)
    altered.writeUInt32LE(flags, clr + 16)
    fs.writeFileSync(target, altered)
    assert.throws(() => distribution.fileInventory(root), /IL-only/)
  }
  assert.throws(() => distribution.validateFiles([{ path: 'unknown.exe', sizeBytes: 1,
    sha256: 'a'.repeat(64), executableArchitecture: null }]), /declare/)
})

test('application and resource public trust remain independent in packaged configuration', t => {
  const root = temporary(t)
  const application = fixture.createSigner().trust
  const resources = fixture.createSigner().trust
  const env = { SIDEKICK_OXY_ORIGIN: 'http://localhost:4318',
    SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(application),
    SIDEKICK_RESOURCE_TRUST_KEYS_JSON: JSON.stringify(resources) }
  const configuration = distribution.applicationConfiguration(root, env)
  assert.deepEqual(configuration.keys, application)
  assert.deepEqual(configuration.resourceKeys, resources)
  distribution.writeApplicationConfiguration(root, configuration)
  const read = name => JSON.parse(fs.readFileSync(path.join(root, 'resources', name)))
  assert.deepEqual(read('application-trust.json'), application)
  assert.deepEqual(read('resource-trust.json'), resources)
  assert.deepEqual(read('oxy-service.json'), { origin: 'http://localhost:4318' })
  assert.throws(() => distribution.writeApplicationConfiguration(root, configuration), /EEXIST/)
})
