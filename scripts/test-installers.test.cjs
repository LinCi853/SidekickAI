const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { nativeTestEnvironment, main } = require('./test-installers.cjs')

const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
const published = { id: 'published-maintenance', publicKey: key }
const base = { SIDEKICK_OXY_ORIGIN: 'http://localhost:4318', SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON: '[]',
  SIDEKICK_RESOURCE_TRUST_KEYS_JSON: JSON.stringify([published]), SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify([published]) }

test('only explicitly isolated tests add fixture trust without changing normal or resource trust', () => {
  const before = structuredClone(base)
  assert.deepEqual(JSON.parse(nativeTestEnvironment(base).SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), [published])
  const isolated = nativeTestEnvironment(base, { PATH: 'isolated-toolchain' }, { testTrust: true })
  assert.equal(isolated.PATH, 'isolated-toolchain')
  assert.equal(JSON.parse(isolated.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON).length, 2)
  assert.equal(isolated.SIDEKICK_RESOURCE_TRUST_KEYS_JSON, base.SIDEKICK_RESOURCE_TRUST_KEYS_JSON)
  assert.deepEqual(base, before)
  assert.throws(() => main(), /explicitly isolated/)
})

test('isolated public trust verifies the native fixture seed and contains no private material', () => {
  const isolated = nativeTestEnvironment({ ...base, SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: '[]' }, {}, { testTrust: true })
  const [fixture] = JSON.parse(isolated.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON)
  assert.equal(fixture.id, 'maintenance-test-publisher')
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 0x63),
  ]), type: 'pkcs8', format: 'der' })
  const bytes = Buffer.from('isolated-maintenance-identity')
  assert.ok(crypto.verify(null, bytes, crypto.createPublicKey({ key: fixture.publicKey, format: 'jwk' }), crypto.sign(null, bytes, privateKey)))
  assert.equal(fixture.publicKey.d, undefined)
  assert.equal(fixture.privateKey, undefined)
})

test('isolated trust rejects conflicting identities and overflow without duplicating a valid fixture', () => {
  const isolated = nativeTestEnvironment(base, {}, { testTrust: true })
  assert.equal(JSON.parse(nativeTestEnvironment(isolated, {}, { testTrust: true }).SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON).length, 2)
  const conflict = { ...base, SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify([{ id: 'maintenance-test-publisher', publicKey: key }]) }
  assert.throws(() => nativeTestEnvironment(conflict, {}, { testTrust: true }), /conflicts/)
  const keys = Array.from({ length: 16 }, (_, index) => ({ id: 'publisher-identity-' + index, publicKey: key }))
  assert.throws(() => nativeTestEnvironment({ ...base, SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(keys) }, {}, { testTrust: true }), /limit/)
})
