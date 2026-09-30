'use strict'

// The standalone uninstaller is a shared component: the independent artifact and the
// copy embedded in each Setup must be the same verified bytes. These tests cover the
// reuse cache that makes that true without regenerating the executable every run.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const m = require('./build-tauri-installer.cjs')
const u = require('./uninstaller-build-utils.cjs')
const { COMPONENT_VERSION: VERSION } = m

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-shared-component-'))
}

/** Structurally valid standalone PE32+ image that the standalone guard accepts. */function standalonePe(size = 0x1000) {
  const bytes = Buffer.alloc(size)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'ascii')
  bytes.writeUInt16LE(0x8664, 0x84)
  bytes.writeUInt16LE(1, 0x86)
  bytes.writeUInt16LE(0xf0, 0x94)
  bytes.writeUInt16LE(0x20b, 0x98)
  bytes.writeUInt32LE(size, 0x98 + 60)
  const section = 0x98 + 0xf0
  bytes.writeUInt32LE(size - 0x200, section + 16)
  bytes.writeUInt32LE(0x200, section + 20)
  return bytes
}

/** A synthetic "already built" component plus its manifest. */
function builtComponent(root, arch = 'x64', fingerprint = 'a'.repeat(64)) {
  const artifact = path.join(root, `built-${arch}.exe`)
  fs.writeFileSync(artifact, standalonePe())
  const bytes = fs.readFileSync(artifact)
  return {
    artifact,
    manifest: {
      protocolVersion: 2,
      edition: require('../product-edition.json').edition,
      componentVersion: VERSION,
      uninstallProtocolVersion: 1,
      arch,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      inputFingerprint: fingerprint,
    },
  }
}

test('a component is remembered, then reused while its inputs are unchanged', () => {
  const cacheRoot = temporary()
  const buildRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(buildRoot, 'x64', expected.fingerprint)

  assert.equal(m.reuseComponent('uninstaller', 'x64', expected, cacheRoot), null, 'an empty cache has nothing to reuse')

  m.rememberComponent('uninstaller', 'x64', expected, built, { files: [] }, cacheRoot)
  const reused = m.reuseComponent('uninstaller', 'x64', expected, cacheRoot)
  assert.ok(reused, 'the remembered component must be reusable')
  assert.equal(reused.reused, true)
  assert.equal(reused.manifest.sha256, built.manifest.sha256)
  assert.deepEqual(fs.readFileSync(reused.artifact), fs.readFileSync(built.artifact), 'reuse must not rewrite bytes')
})

test('a version bump or any input change forces regeneration', () => {
  const cacheRoot = temporary()
  const buildRoot = temporary()
  const stored = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(buildRoot, 'x64', stored.fingerprint)
  m.rememberComponent('uninstaller', 'x64', stored, built, {}, cacheRoot)

  // Source change: the content fingerprint moves.
  assert.equal(m.reuseComponent('uninstaller', 'x64', { version: VERSION, fingerprint: 'b'.repeat(64) }, cacheRoot), null)
  // Version bump: the record is keyed by version as well.
  assert.equal(m.reuseComponent('uninstaller', 'x64', { version: '0.2.0', fingerprint: stored.fingerprint }, cacheRoot), null)
  // Architecture mismatch is never silently reused.
  assert.equal(m.reuseComponent('uninstaller', 'arm64', stored, cacheRoot), null)
})

test('source and compiled input fingerprints can differ without disabling reuse', () => {
  const cacheRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(temporary(), 'x64', 'b'.repeat(64))
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)
  assert.ok(m.reuseComponent('uninstaller', 'x64', expected, cacheRoot))
})

test('a rebuilt component replaces stale bytes at the same product version', () => {
  const cacheRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(temporary(), 'x64', expected.fingerprint)
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)
  const bytes = fs.readFileSync(built.artifact)
  bytes[bytes.length - 1] = 123
  fs.writeFileSync(built.artifact, bytes)
  built.manifest.sha256 = u.sha256(built.artifact)
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)
  const reused = m.reuseComponent('uninstaller', 'x64', expected, cacheRoot)
  assert.ok(reused)
  assert.equal(u.sha256(reused.artifact), built.manifest.sha256)
})

test('a tampered cache entry is refused instead of packaged', () => {
  const cacheRoot = temporary()
  const buildRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(buildRoot, 'x64', expected.fingerprint)
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)

  const cachedExe = m.reuseComponent('uninstaller', 'x64', expected, cacheRoot).artifact
  // Flip one byte: the stored hash no longer describes the file.
  const tampered = fs.readFileSync(cachedExe)
  tampered[tampered.length - 1] ^= 0xff
  fs.writeFileSync(cachedExe, tampered)

  assert.equal(m.reuseComponent('uninstaller', 'x64', expected, cacheRoot), null, 'a drifted executable must not be reused')
})

test('an unreadable cache record is ignored, not fatal', () => {
  const cacheRoot = temporary()
  const buildRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(buildRoot, 'x64', expected.fingerprint)
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)

  const record = path.join(m.componentCacheDirectory('uninstaller', cacheRoot), 'x64', `${expected.fingerprint}.json`)
  fs.writeFileSync(record, '{ this is not json')
  assert.equal(m.reuseComponent('uninstaller', 'x64', expected, cacheRoot), null)
})

test('SIDEKICK_REBUILD_SHARED_COMPONENTS forces a rebuild path', () => {
  const cacheRoot = temporary()
  const buildRoot = temporary()
  const expected = { version: VERSION, fingerprint: 'a'.repeat(64) }
  const built = builtComponent(buildRoot, 'x64', expected.fingerprint)
  m.rememberComponent('uninstaller', 'x64', expected, built, {}, cacheRoot)

  const previous = process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS
  process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS = '1'
  try {
    assert.equal(m.reuseComponent('uninstaller', 'x64', expected, cacheRoot), null)
  } finally {
    if (previous === undefined) delete process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS
    else process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS = previous
  }
})

test('cache directory names cannot escape the cache root', () => {
  const cacheRoot = temporary()
  const escaped = m.componentCacheDirectory('../../evil', cacheRoot)
  assert.equal(path.dirname(escaped), cacheRoot)
  assert.equal(escaped.startsWith(cacheRoot + path.sep), true)
})

test('verifyArtifact accepts the manifest the cache stores and rejects tampering', () => {
  const root = temporary()
  const built = builtComponent(root)
  const deployed = u.deploymentManifest(built.manifest, m.VERSION)
  const info = u.verifyArtifact(built.artifact, deployed, 'x64', m.VERSION)
  assert.equal(info.arch, 'x64')
  assert.equal(info.sha256, built.manifest.sha256)

  assert.throws(() => u.verifyArtifact(built.artifact, deployed, 'x64', '0.2.0'), /does not match current artifact/)
  assert.throws(() => u.verifyArtifact(built.artifact, deployed, 'arm64', m.VERSION), /ARCH_MISMATCH|does not match/)
  assert.throws(() => u.verifyArtifact(built.artifact, { ...deployed, sha256: 'c'.repeat(64) }, 'x64', m.VERSION), /does not match current artifact/)
  assert.throws(() => u.verifyArtifact(built.artifact, { ...deployed, edition: deployed.edition === 'concept' ? 'community' : 'concept' }, 'x64', m.VERSION), /does not match current artifact/)
})
