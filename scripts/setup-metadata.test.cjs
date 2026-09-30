'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const metadata = require('./setup-metadata.cjs')
const u = require('./uninstaller-build-utils.cjs')
const versionedPe = require('./test-fixtures/versioned-pe.cjs')

function assembled(manifest = require('./gen-install-manifest.cjs').generateManifest()) {
  const payload = Buffer.from('application payload')
  const extractor = Buffer.from('extractor')
  const data = Buffer.from(JSON.stringify(metadata.createMetadata(manifest, payload, extractor)))
  return Buffer.concat([versionedPe(), payload, extractor, data, metadata.footer(data, payload.length, extractor.length)])
}

test('one raw maintenance program carries different product versions and option defaults', () => {
  const raw = versionedPe()
  const rawDigest = metadata.digest(raw)
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  for (const version of ['0.1.5-beta-rc', '0.9.0']) {
    const manifest = require('./gen-install-manifest.cjs').generateManifest()
    manifest.productVersion = version
    manifest.options[0].defaultValue = version === '0.9.0'
    const parsed = metadata.readMetadata(assembled(manifest)).metadata
    assert.equal(parsed.productVersion, version)
    assert.equal(parsed.options[0].defaultValue, version === '0.9.0')
    const stamped = metadata.stampProductVersion(raw, version)
    const info = Resource.VersionInfo.fromEntries(NtExecutableResource.from(NtExecutable.from(stamped)).entries)[0]
    assert.equal(info.getStringValues({ lang: 1033, codepage: 1200 }).ProductVersion, version)
    assert.equal(info.fixedInfo.fileVersionMS, 65536)
    assert.equal(info.fixedInfo.fileVersionLS, 0)
  }
  assert.equal(metadata.digest(raw), rawDigest)
})

test('damaged, truncated, oversized and incompatible setup data is refused', () => {
  const original = assembled()
  for (const offset of [1, 8, 16, 24, 32, 64]) {
    const bytes = Buffer.from(original)
    bytes[bytes.length - metadata.FOOTER_SIZE + offset] ^= 255
    assert.throws(() => metadata.readMetadata(bytes))
  }
  assert.throws(() => metadata.readMetadata(original.subarray(0, -1)))
  const layout = metadata.ranges(original)
  for (const offset of [layout.wizard, layout.wizard + layout.payload, layout.metadataOffset]) {
    const bytes = Buffer.from(original)
    bytes[offset] ^= 1
    assert.throws(() => metadata.readMetadata(bytes), /digest|JSON/)
  }
  for (const field of ['schemaVersion', 'componentVersion', 'edition', 'productVersion']) {
    const manifest = require('./gen-install-manifest.cjs').generateManifest()
    manifest[field] = field === 'schemaVersion' ? 99 : 'invalid/value'
    assert.throws(() => assembled(manifest), /metadata/)
  }
  const manifest = require('./gen-install-manifest.cjs').generateManifest()
  manifest.options[0].id = 'runCommand'
  assert.throws(() => assembled(manifest), /option/)
})

test('inspection retains historical footer support while new metadata remains mandatory', () => {
  const footer = Buffer.alloc(28)
  footer.write('SKPAYLD1')
  footer.writeBigUInt64LE(3n, 8)
  footer.writeBigUInt64LE(2n, 16)
  footer.writeUInt32LE(28, 24)
  const legacy = Buffer.concat([versionedPe(), Buffer.from('abcde'), footer])
  assert.equal(u.footerInfo(legacy).payload, 3)
  assert.throws(() => metadata.readMetadata(legacy), /missing/)
  assert.equal(u.footerInfo(assembled()).protocolVersion, 2)
})
