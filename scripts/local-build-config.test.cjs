'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { cloudBuildEnvironment } = require('./oxy-build-config.cjs')
const { localBuildEnvironment } = require('./local-build-config.cjs')

function workspace(t) {
  const parent = path.resolve(__dirname, '../build/local-build-config-tests')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'workspace-'))
  fs.mkdirSync(path.join(root, 'local'))
  fs.mkdirSync(path.join(root, 'resources'))
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true }) })
  return root
}

function configure(root) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const keys = [{ id: 'public-test-key', publicKey: publicKey.export({ format: 'jwk' }) }]
  const config = { schemaVersion: 1, publicConfiguration: { origin: 'https://fixture.test',
    distributionKeys: keys, resourceKeys: keys, allowedHosts: ['fixture.test'] } }
  const file = path.join(root, 'local/distribution-build.json')
  fs.writeFileSync(file, JSON.stringify(config))
  return { config, file, keys }
}

test('a software-only workspace builds with no trust or private configuration', t => {
  const root = workspace(t)
  const cloud = cloudBuildEnvironment({}, path.join(root, 'resources/oxy-deployment.json'))
  assert.equal(cloud.SIDEKICK_OXY_ORIGIN, '')
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), [])
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_RESOURCE_TRUST_KEYS_JSON), [])
  assert.deepEqual(localBuildEnvironment(root, {}), {})
})

test('public configuration remains local to the selected workspace', t => {
  const root = workspace(t)
  const { keys } = configure(root)
  const cloud = cloudBuildEnvironment({}, path.join(root, 'resources/oxy-deployment.json'))
  assert.equal(cloud.SIDEKICK_OXY_ORIGIN, 'https://fixture.test')
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), keys)
  const sibling = workspace(t)
  assert.deepEqual(JSON.parse(cloudBuildEnvironment({}, path.join(sibling, 'resources/oxy-deployment.json')).SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), [])
})

test('explicit public environment overrides workspace defaults', t => {
  const root = workspace(t)
  configure(root)
  const cloud = cloudBuildEnvironment({ SIDEKICK_OXY_ORIGIN: 'https://override.test',
    SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON: '[]' }, path.join(root, 'resources/oxy-deployment.json'))
  assert.equal(cloud.SIDEKICK_OXY_ORIGIN, 'https://override.test')
  assert.deepEqual(JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON), [])
})

test('public build configuration rejects private key material and invalid structure', t => {
  const root = workspace(t)
  const { config, file } = configure(root)
  config.publicConfiguration.resourceKeys[0].publicKey.d = 'private-key-material'
  fs.writeFileSync(file, JSON.stringify(config))
  assert.throws(() => cloudBuildEnvironment({}, path.join(root, 'resources/oxy-deployment.json')), /Only public/)
  for (const value of [{ schemaVersion: 2 }, { schemaVersion: 1, unknown: {} }]) {
    fs.writeFileSync(file, JSON.stringify(value))
    assert.throws(() => localBuildEnvironment(root, {}), /configuration/)
  }
  fs.writeFileSync(file, '{invalid')
  assert.throws(() => localBuildEnvironment(root, {}), /Cannot parse/)
})

test('tool directories preserve inherited search paths without duplicates', t => {
  const root = workspace(t)
  const { config, file } = configure(root)
  const directory = path.join(root, 'compiler')
  config.toolDirectories = [directory]
  fs.writeFileSync(file, JSON.stringify(config))
  const initial = { PATH: path.join(root, 'inherited') }
  const loaded = localBuildEnvironment(root, initial)
  assert.equal(loaded.PATH, directory + path.delimiter + initial.PATH)
  assert.equal(localBuildEnvironment(root, loaded).PATH, loaded.PATH)
  assert.equal(initial.PATH, path.join(root, 'inherited'))
})
