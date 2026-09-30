'use strict'

const { createHash } = require('node:crypto')
const { readContract, SEMVER } = require('./component-contract.cjs')

const MAGIC = Buffer.from('SKPAYLD2')
const FOOTER_SIZE = 68
const MAX_METADATA_SIZE = 1024 * 1024
const MAX_EXTRACTOR_SIZE = 32 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const unique = values => new Set(values).size === values.length

function validateManifest(value, contract = readContract(), edition = require('../product-edition.json').edition) {
  if (value.schemaVersion !== contract.setupProtocolVersion || value.edition !== edition
    || !SEMVER.test(value.productVersion ?? '') || value.componentVersion !== contract.componentVersion
    || value.uninstallProtocolVersion !== contract.uninstallProtocolVersion
    || !Array.isArray(value.features) || !Array.isArray(value.options)
    || value.features.length > 128 || value.options.length > 128
    || !unique(value.features.map(item => item.id)) || !unique(value.options.map(item => item.id))) throw new Error('Incompatible Setup metadata')
  for (const feature of value.features) {
    if (!contract.supportedFeatures.includes(feature.id) || typeof feature.defaultEnabled !== 'boolean'
      || typeof feature.name !== 'string' || typeof feature.description !== 'string'
      || !['stable', 'dev'].includes(feature.category) || !['small', 'large'].includes(feature.sizeLevel)
      || feature.required !== undefined && typeof feature.required !== 'boolean'
      || feature.installRequired !== undefined && typeof feature.installRequired !== 'boolean') throw new Error('Unsupported installation feature')
  }
  for (const option of value.options) {
    const supported = contract.supportedOptions[option.id]
    if (!supported || supported.type !== option.type || typeof option.label !== 'string' || typeof option.description !== 'string'
      || option.page !== undefined && !['behavior', 'logging'].includes(option.page)) throw new Error('Unsupported installation option')
    if (option.type === 'boolean' && (typeof option.defaultValue !== 'boolean' || option.choices !== undefined)) throw new Error('Invalid boolean option')
    if (option.type === 'choice' && (!Array.isArray(option.choices) || !option.choices.length
      || !unique(option.choices.map(item => item.value)) || !option.choices.some(item => item.value === option.defaultValue)
      || option.choices.some(item => !supported.values.includes(item.value) || typeof item.label !== 'string'))) throw new Error('Invalid choice option')
  }
  return value
}

function createMetadata(manifest, payload, extractor) {
  validateManifest(manifest)
  return { ...manifest, payload: { size: payload.length, sha256: digest(payload) }, extractor: { size: extractor.length, sha256: digest(extractor) } }
}

function footer(metadataBytes, payloadSize, extractorSize) {
  if (!metadataBytes.length || metadataBytes.length > MAX_METADATA_SIZE || payloadSize <= 0
    || extractorSize <= 0 || extractorSize > MAX_EXTRACTOR_SIZE) throw new Error('Invalid Setup data sizes')
  const bytes = Buffer.alloc(FOOTER_SIZE)
  MAGIC.copy(bytes)
  bytes.writeBigUInt64LE(BigInt(payloadSize), 8)
  bytes.writeBigUInt64LE(BigInt(extractorSize), 16)
  bytes.writeBigUInt64LE(BigInt(metadataBytes.length), 24)
  Buffer.from(digest(metadataBytes), 'hex').copy(bytes, 32)
  bytes.writeUInt32LE(FOOTER_SIZE, 64)
  return bytes
}

function ranges(bytes) {
  if (bytes.length < FOOTER_SIZE || !bytes.subarray(-FOOTER_SIZE, -FOOTER_SIZE + 8).equals(MAGIC)) return null
  const at = bytes.length - FOOTER_SIZE
  if (bytes.readUInt32LE(at + 64) !== FOOTER_SIZE) throw new Error('Invalid Setup footer length')
  const [payload, sevenz, metadata] = [8, 16, 24].map(offset => Number(bytes.readBigUInt64LE(at + offset)))
  const wizard = at - payload - sevenz - metadata
  if (![payload, sevenz, metadata, wizard].every(value => Number.isSafeInteger(value) && value > 0)
    || sevenz > MAX_EXTRACTOR_SIZE || metadata > MAX_METADATA_SIZE) throw new Error('Invalid Setup footer ranges')
  const metadataOffset = wizard + payload + sevenz
  if (digest(bytes.subarray(metadataOffset, at)) !== bytes.subarray(at + 32, at + 64).toString('hex')) throw new Error('Setup metadata digest mismatch')
  return { protocolVersion: 2, wizard, payload, sevenz, metadata, metadataOffset, footer: FOOTER_SIZE }
}

function readMetadata(bytes) {
  const layout = ranges(bytes)
  if (!layout) throw new Error('Setup metadata is missing')
  const value = JSON.parse(bytes.subarray(layout.metadataOffset, layout.metadataOffset + layout.metadata).toString('utf8'))
  validateManifest(value)
  for (const [name, size, offset] of [['payload', layout.payload, layout.wizard], ['extractor', layout.sevenz, layout.wizard + layout.payload]]) {
    if (value[name]?.size !== size || value[name]?.sha256 !== digest(bytes.subarray(offset, offset + size))) throw new Error(`Setup ${name} digest mismatch`)
  }
  return { metadata: value, layout }
}

function stampProductVersion(bytes, version) {
  if (!SEMVER.test(version)) throw new Error('Invalid Setup product version')
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  const executable = NtExecutable.from(bytes)
  if (executable.getExtraData()?.byteLength) throw new Error('Raw wizard has unexpected overlay data')
  const resources = NtExecutableResource.from(executable)
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  if (!versions.length) throw new Error('Wizard product version resource is missing')
  const numeric = version.split(/[+-]/)[0].split('.').map(Number)
  if (numeric.some(value => value > 65535)) throw new Error('Setup product version exceeds Windows resource limits')
  for (const info of versions) {
    info.setProductVersion(...numeric, 0)
    for (const language of info.getAllLanguagesForStringValues()) info.setStringValue(language, 'ProductVersion', version)
    info.outputToResourceEntries(resources.entries)
  }
  resources.outputResource(executable)
  const result = Buffer.from(executable.generate())
  const actual = Resource.VersionInfo.fromEntries(NtExecutableResource.from(NtExecutable.from(result)).entries)
  if (!actual.length || actual.some(info => info.getAllLanguagesForStringValues().some(language => info.getStringValues(language).ProductVersion !== version))) throw new Error('Setup product version resource did not verify')
  return result
}

module.exports = { MAGIC, FOOTER_SIZE, MAX_METADATA_SIZE, MAX_EXTRACTOR_SIZE, digest, validateManifest, createMetadata, footer, ranges, readMetadata, stampProductVersion }
