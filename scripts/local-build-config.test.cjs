'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const distribution = require('./application-distribution.cjs')
const { cloudBuildEnvironment } = require('./oxy-build-config.cjs')
const fixture = require('./test-fixtures/distribution-signing.cjs')

function workspace(t) {
  const parent = path.resolve(__dirname, '../build/local-build-config-tests')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'workspace-'))
  fs.mkdirSync(path.join(root, 'local'))
  fs.mkdirSync(path.join(root, 'resources'))
  t.after(() => {
    assert.equal(path.dirname(root), parent)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

function configure(root, signer = fixture.createSigner()) {
  fs.mkdirSync(path.join(root, 'local'), { recursive: true })
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  const keysFile = path.join(root, 'signing.json')
  const trustFile = path.join(root, 'trust.json')
  const instanceId = crypto.randomUUID()
  fs.writeFileSync(keysFile, JSON.stringify({ formatVersion: 1, instanceId,
    adminKeys: [{ id: signer.id, privateKey: signer.privateKey.export({ format: 'jwk' }) }] }))
  fs.writeFileSync(trustFile, JSON.stringify({ formatVersion: 1, instanceId, adminKeys: signer.trust }))
  const config = { schemaVersion: 1, publicConfiguration: { origin: 'https://fixture.test',
    distributionKeys: signer.trust, resourceKeys: signer.trust, allowedHosts: ['fixture.test'] },
    signingIdentity: { keysFile, trustFile } }
  fs.writeFileSync(path.join(root, 'local/distribution-build.json'), JSON.stringify(config))
  return { config, signer }
}

test('a fresh build process uses its workspace configuration for public trust and signing', t => {
  const root = workspace(t)
  const { signer } = configure(root)
  assert.deepEqual(distribution.publicTrust(root, {}), signer.trust)
  const cloud = cloudBuildEnvironment({}, path.join(root, 'resources/oxy-deployment.json'))
  assert.equal(cloud.SIDEKICK_OXY_ORIGIN, 'https://fixture.test')
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), signer.trust)
  const loaded = distribution.loadLocalSigner(root, {})
  assert.equal(loaded.id, signer.id)
  distribution.signEnvelope(fixture.runtimePayload(), distribution.PURPOSES.runtime, loaded)
  assert.deepEqual(Object.keys(cloud).sort(), ['SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON', 'SIDEKICK_OXY_ORIGIN',
    'SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON', 'SIDEKICK_RESOURCE_TRUST_KEYS_JSON'])
})

test('explicit signing and public environment values override local defaults', t => {
  const root = workspace(t)
  configure(root)
  const override = path.join(root, 'override')
  fs.mkdirSync(override)
  const { signer, config } = configure(override)
  const env = { SIDEKICK_OXY_ORIGIN: 'https://override.test', SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON: '[]',
    SIDEKICK_RESOURCE_TRUST_KEYS_JSON: JSON.stringify(signer.trust),
    SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(signer.trust),
    SIDEKICK_DISTRIBUTION_SIGNING_KEYS_FILE: config.signingIdentity.keysFile,
    SIDEKICK_DISTRIBUTION_SIGNING_TRUST_FILE: config.signingIdentity.trustFile }
  assert.equal(distribution.loadLocalSigner(root, env).id, signer.id)
  assert.equal(cloudBuildEnvironment(env, path.join(root, 'resources/oxy-deployment.json')).SIDEKICK_OXY_ORIGIN, 'https://override.test')
})

test('workspace configuration does not confer signing trust to a sibling workspace', t => {
  const root = workspace(t)
  configure(root)
  const sibling = workspace(t)
  assert.throws(() => distribution.publicTrust(sibling, {}), /trust is required/)
  const cloud = cloudBuildEnvironment({}, path.join(sibling, 'resources/oxy-deployment.json'))
  assert.equal(cloud.SIDEKICK_OXY_ORIGIN, '')
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), [])
})

test('a local configuration still rejects private public inputs and mismatched signer identity', t => {
  const root = workspace(t)
  const { config } = configure(root)
  const file = path.join(root, 'local/distribution-build.json')
  const wrong = fixture.createSigner()
  config.publicConfiguration.distributionKeys = wrong.trust
  fs.writeFileSync(file, JSON.stringify(config))
  assert.throws(() => distribution.loadLocalSigner(root, {}), /matches/)
  config.publicConfiguration.resourceKeys = [{ ...wrong.trust[0], privateKey: wrong.privateKey.export({ format: 'jwk' }) }]
  fs.writeFileSync(file, JSON.stringify(config))
  assert.throws(() => cloudBuildEnvironment({}, path.join(root, 'resources/oxy-deployment.json')), /Only public/)
})

test('invalid local configuration cannot be bypassed with an explicit public environment', t => {
  const root = workspace(t)
  const { config, signer } = configure(root)
  const file = path.join(root, 'local/distribution-build.json')
  const env = { SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: JSON.stringify(signer.trust) }
  for (const value of [{ ...config, schemaVersion: 2 }, { ...config, environment: {} },
    { ...config, signingIdentity: { keysFile: 'relative.json', trustFile: 'relative.json' } }]) {
    fs.writeFileSync(file, JSON.stringify(value))
    assert.throws(() => distribution.publicTrust(root, env), /local|Local/)
  }
  fs.writeFileSync(file, '{invalid')
  assert.throws(() => cloudBuildEnvironment(env, path.join(root, 'resources/oxy-deployment.json')), /Cannot parse/)
})

test('build tools preserve inherited search paths without accumulating duplicate directories', t => {
  const root = workspace(t)
  const { config } = configure(root)
  const directory = path.join(root, 'compiler')
  config.toolDirectories = [directory]
  fs.writeFileSync(path.join(root, 'local/distribution-build.json'), JSON.stringify(config))
  const { localBuildEnvironment } = require('./local-build-config.cjs')
  const initial = { PATH: path.join(root, 'inherited') }
  const loaded = localBuildEnvironment(root, initial)
  assert.equal(loaded.PATH, directory + path.delimiter + initial.PATH)
  assert.equal(localBuildEnvironment(root, loaded).PATH, loaded.PATH)
  assert.equal(initial.PATH, path.join(root, 'inherited'))
})
