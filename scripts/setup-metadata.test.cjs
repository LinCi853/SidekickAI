'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const metadata = require('./setup-metadata.cjs')
const u = require('./uninstaller-build-utils.cjs')
const versionedPe = require('./test-fixtures/versioned-pe.cjs')
const distribution = require('./application-distribution.cjs')
const signing = require('./test-fixtures/distribution-signing.cjs')

function preparedManifest() {
  const manifest = require('./gen-install-manifest.cjs').generateManifest()
  if (manifest.distributionMode === 'offline') manifest.distributionProof = distribution.signEnvelope(
    signing.bodyPayload({ edition: manifest.edition, arch: manifest.targetArchitecture, version: manifest.productVersion }),
    distribution.PURPOSES.body, signing.createSigner())
  return manifest
}

function assembled(manifest = preparedManifest()) {
  const payload = manifest.distributionMode === 'online' ? Buffer.alloc(0) : Buffer.from('application payload')
  const data = Buffer.from(JSON.stringify(metadata.createMetadata(manifest, payload)))
  return Buffer.concat([versionedPe(manifest.executableArchitecture), payload, data, metadata.footer(data, payload.length, 0)])
}

test('maintenance metadata keeps product identity and defaults separate from the raw executable', () => {
  const raw = versionedPe()
  const rawDigest = metadata.digest(raw)
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  for (const version of ['0.1.5-beta.1', '0.9.0']) {
    const manifest = preparedManifest()
    manifest.productVersion = version
    manifest.options[0].defaultValue = version === '0.9.0'
    const parsed = metadata.readMetadata(assembled(manifest)).metadata
    assert.equal(parsed.productVersion, version)
    assert.equal(parsed.options[0].defaultValue, version === '0.9.0')
    assert.equal(parsed.extractor, null)
    assert.equal((parsed.payload?.size ?? 0) > 0, parsed.distributionMode === 'offline')
    const stamped = metadata.stampProductVersion(raw, version)
    const info = Resource.VersionInfo.fromEntries(NtExecutableResource.from(NtExecutable.from(stamped)).entries)[0]
    assert.equal(info.getStringValues({ lang: 1033, codepage: 1200 }).ProductVersion, version)
    assert.equal(info.fixedInfo.fileVersionMS, 65536)
    assert.equal(info.fixedInfo.fileVersionLS, 0)
  }
  assert.equal(metadata.digest(raw), rawDigest)
})

test('assembled metadata represents absent online payloads as null and preserves offline payload digests', () => {
  const manifest = preparedManifest()
  const bytes = assembled(manifest)
  const { metadata: parsed, layout } = metadata.readMetadata(bytes)
  if (manifest.distributionMode === 'online') {
    assert.equal(parsed.payload, null)
    assert.equal(layout.payload, 0)
  } else {
    const payload = bytes.subarray(layout.wizard, layout.wizard + layout.payload)
    assert.deepEqual(parsed.payload, { size: payload.length, sha256: metadata.digest(payload) })
    assert(payload.length > 0)
  }
  const replacePayload = payload => {
    const altered = Buffer.from(JSON.stringify({ ...parsed, payload }))
    return Buffer.concat([bytes.subarray(0, layout.metadataOffset), altered, metadata.footer(altered, layout.payload, 0)])
  }
  if (manifest.distributionMode === 'online') {
    assert.throws(() => metadata.readMetadata(replacePayload({ size: 0, sha256: metadata.digest(Buffer.alloc(0)) })), /metadata|payload/)
    assert.throws(() => metadata.readMetadata(replacePayload(undefined)), /payload/)
    assert.throws(() => metadata.validateManifest({ ...manifest, payload: { size: 0, sha256: metadata.digest(Buffer.alloc(0)) } }), /metadata/)
  } else {
    assert.throws(() => metadata.readMetadata(replacePayload(null)), /payload/)
    assert.throws(() => metadata.readMetadata(replacePayload({ ...parsed.payload, sha256: '0'.repeat(64) })), /payload/)
  }
})

test('damaged containers, unsupported metadata and external extractors are refused', () => {
  const original = assembled()
  for (const offset of [1, 8, 16, 24, 32, 64]) {
    const bytes = Buffer.from(original)
    bytes[bytes.length - metadata.FOOTER_SIZE + offset] ^= 255
    assert.throws(() => metadata.readMetadata(bytes))
  }
  assert.throws(() => metadata.readMetadata(original.subarray(0, -1)))
  const layout = metadata.ranges(original)
  for (const offset of [layout.metadataOffset, ...(layout.payload ? [layout.wizard] : [])]) {
    const bytes = Buffer.from(original)
    bytes[offset] ^= 1
    assert.throws(() => metadata.readMetadata(bytes), /digest|JSON/)
  }
  for (const field of ['schemaVersion', 'componentVersion', 'edition', 'productVersion']) {
    const manifest = preparedManifest()
    manifest[field] = field === 'schemaVersion' ? 99 : 'invalid/value'
    assert.throws(() => assembled(manifest), /metadata/)
  }
  const manifest = preparedManifest()
  manifest.options[0].id = 'runCommand'
  assert.throws(() => assembled(manifest), /option/)
  assert.throws(() => metadata.createMetadata(preparedManifest(), Buffer.alloc(0), Buffer.from('extractor')), /payload|extractor/)
  assert.throws(() => metadata.footer(Buffer.from('{}'), 1, 2), /sizes/)
})

test('historical overlay protocols are rejected', () => {
  for (const magic of ['SKPAYLD1', 'SKSETUP2']) {
    const footer = Buffer.alloc(magic === 'SKPAYLD1' ? 28 : metadata.FOOTER_SIZE)
    footer.write(magic)
    const legacy = Buffer.concat([versionedPe(), Buffer.from('abcde'), footer])
    assert.equal(u.footerInfo(legacy), null)
    assert.throws(() => metadata.readMetadata(legacy), /missing/)
  }
  assert.equal(u.footerInfo(assembled()).protocolVersion, 3)
})

test('a certificate table after the overlay preserves metadata without admitting arbitrary trailing data', () => {
  const bytes = assembled()
  const padding = (8 - bytes.length % 8) % 8
  const certificateStart = bytes.length + padding
  const signed = Buffer.concat([bytes, Buffer.alloc(padding), Buffer.alloc(64)])
  const optional = signed.readUInt32LE(0x3c) + 24
  signed.writeUInt32LE(16, optional + 108)
  signed.writeUInt32LE(certificateStart, optional + 144)
  signed.writeUInt32LE(64, optional + 148)
  assert.equal(metadata.readMetadata(signed).layout.containerEnd, bytes.length)
  const altered = Buffer.from(signed)
  altered.writeUInt32LE(63, optional + 148)
  assert.throws(() => metadata.readMetadata(altered), /certificate/)
  if (padding) {
    signed[bytes.length] = 1
    assert.throws(() => metadata.readMetadata(signed), /missing/)
  }
})
