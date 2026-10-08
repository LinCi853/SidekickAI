'use strict'

const { createHash } = require('node:crypto')
const { readContract, SEMVER } = require('./component-contract.cjs')

const MAGIC = Buffer.from('SKSETUP3')
const FOOTER_SIZE = 68
const MAX_METADATA_SIZE = 8 * 1024 * 1024
const MAX_EXTRACTOR_SIZE = 32 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const unique = values => new Set(values).size === values.length

function validateManifest(value, contract = readContract(), edition = require('../product-edition.json').edition, { requireProof = true } = {}) {
  if (value.schemaVersion !== contract.setupProtocolVersion || value.edition !== edition
    || !SEMVER.test(value.productVersion ?? '') || value.componentVersion !== contract.componentVersion
    || value.uninstallProtocolVersion !== contract.uninstallProtocolVersion
    || value.distributionProtocolVersion !== contract.distributionProtocolVersion
    || !['online', 'offline'].includes(value.distributionMode)
    || !['x64', 'arm64'].includes(value.executableArchitecture)
    || !Array.isArray(value.supportedNativeArchitectures) || !unique(value.supportedNativeArchitectures)
    || value.supportedNativeArchitectures.some(arch => !['x64', 'arm64'].includes(arch))
    || value.distributionMode === 'online' && (edition !== 'community' || value.targetArchitecture !== null
      || value.executableArchitecture !== 'x64' || value.supportedNativeArchitectures.length !== 2 || value.distributionProof !== null
      || Object.hasOwn(value, 'payload') && value.payload !== null)
    || value.distributionMode === 'offline' && (edition !== 'concept' || value.targetArchitecture !== value.executableArchitecture
      || value.supportedNativeArchitectures.length !== 1 || value.supportedNativeArchitectures[0] !== value.targetArchitecture
      || requireProof && (!value.distributionProof || typeof value.distributionProof.signature !== 'string'))
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

function createMetadata(manifest, payload, extractor = Buffer.alloc(0)) {
  validateManifest(manifest)
  if (manifest.distributionMode === 'online' && payload.length !== 0
    || manifest.distributionMode === 'offline' && payload.length === 0) throw new Error('Setup mode and payload do not match')
  if (extractor.length !== 0) throw new Error('Native ZIP extraction does not accept an external extractor')
  return { ...manifest, payload: manifest.distributionMode === 'online' ? null : { size: payload.length, sha256: digest(payload) }, extractor: null }
}

function footer(metadataBytes, payloadSize, extractorSize) {
  if (!metadataBytes.length || metadataBytes.length > MAX_METADATA_SIZE || !Number.isSafeInteger(payloadSize) || payloadSize < 0
    || extractorSize !== 0) throw new Error('Invalid Setup data sizes')
  const bytes = Buffer.alloc(FOOTER_SIZE)
  MAGIC.copy(bytes)
  bytes.writeBigUInt64LE(BigInt(payloadSize), 8)
  bytes.writeBigUInt64LE(BigInt(extractorSize), 16)
  bytes.writeBigUInt64LE(BigInt(metadataBytes.length), 24)
  Buffer.from(digest(metadataBytes), 'hex').copy(bytes, 32)
  bytes.writeUInt32LE(FOOTER_SIZE, 64)
  return bytes
}

function containerEnd(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return bytes.length
  const pe = bytes.readUInt32LE(0x3c)
  const optional = pe + 24
  if (pe > bytes.length - 24 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || optional + 152 > bytes.length || bytes.readUInt16LE(pe + 20) < 152 || bytes.readUInt32LE(optional + 108) <= 4) return bytes.length
  const certificateStart = bytes.readUInt32LE(optional + 144)
  const certificateSize = bytes.readUInt32LE(optional + 148)
  if (!certificateSize) return bytes.length
  if (certificateStart <= FOOTER_SIZE || certificateStart + certificateSize !== bytes.length || certificateStart % 8) {
    throw new Error('Invalid Setup certificate range')
  }
  for (let padding = 0; padding <= 7; padding++) {
    const end = certificateStart - padding
    if (end >= FOOTER_SIZE && bytes.subarray(end - FOOTER_SIZE, end - FOOTER_SIZE + 8).equals(MAGIC)
      && bytes.subarray(end, certificateStart).every(byte => byte === 0)) return end
  }
  return certificateStart
}

function ranges(bytes) {
  const end = containerEnd(bytes)
  if (end < FOOTER_SIZE || !bytes.subarray(end - FOOTER_SIZE, end - FOOTER_SIZE + 8).equals(MAGIC)) return null
  const at = end - FOOTER_SIZE
  if (bytes.readUInt32LE(at + 64) !== FOOTER_SIZE) throw new Error('Invalid Setup footer length')
  const [payload, sevenz, metadata] = [8, 16, 24].map(offset => Number(bytes.readBigUInt64LE(at + offset)))
  const wizard = at - payload - sevenz - metadata
  if (!Number.isSafeInteger(payload) || payload < 0 || sevenz !== 0
    || ![metadata, wizard].every(value => Number.isSafeInteger(value) && value > 0)
    || metadata > MAX_METADATA_SIZE) throw new Error('Invalid Setup footer ranges')
  const metadataOffset = wizard + payload + sevenz
  if (digest(bytes.subarray(metadataOffset, at)) !== bytes.subarray(at + 32, at + 64).toString('hex')) throw new Error('Setup metadata digest mismatch')
  return { protocolVersion: 3, wizard, payload, sevenz, metadata, metadataOffset, footer: FOOTER_SIZE, containerEnd: end }
}

function readMetadata(bytes) {
  const layout = ranges(bytes)
  if (!layout) throw new Error('Setup metadata is missing')
  const value = JSON.parse(bytes.subarray(layout.metadataOffset, layout.metadataOffset + layout.metadata).toString('utf8'))
  validateManifest(value)
  if (value.distributionMode === 'online' && layout.payload !== 0 || value.distributionMode === 'offline' && layout.payload === 0) {
    throw new Error('Setup mode and payload do not match')
  }
  const validPayload = value.distributionMode === 'online' ? value.payload === null
    : value.payload?.size === layout.payload && value.payload?.sha256 === digest(bytes.subarray(layout.wizard, layout.wizard + layout.payload))
  if (value.extractor !== null || !validPayload) throw new Error('Setup payload digest mismatch')
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

module.exports = { MAGIC, FOOTER_SIZE, MAX_METADATA_SIZE, MAX_EXTRACTOR_SIZE, digest, validateManifest, createMetadata, footer, containerEnd, ranges, readMetadata, stampProductVersion }
