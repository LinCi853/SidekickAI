'use strict'

const fs = require('node:fs')
const path = require('node:path')
const u = require('./build-utils.cjs')
const runtime = require('./application-runtime.cjs')
const application = require('./application-packaging.cjs')

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_FILES = 5000
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/

function exact(value, keys, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Invalid application payload ' + label)
}

function validatePayloadPath(value) {
  runtime.validateSoftwarePath(value)
  if (/^(?:SidekickAI|win-unpacked|win-arm64-unpacked)(?:\/|$)/i.test(value)
    || /(?:^|\/)(?:portable\.txt|portable-layout\.json|portable-manifest\.json)$/i.test(value)) {
    throw new Error('Application payload must contain a normal application runtime')
  }
  return value
}

function validateManifest(manifest) {
  exact(manifest, ['schemaVersion', 'kind', 'edition', 'productVersion', 'architecture', 'archive', 'files'], 'manifest fields')
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'application-payload'
    || !['concept', 'community'].includes(manifest.edition) || typeof manifest.productVersion !== 'string'
    || manifest.productVersion.length > 64 || !VERSION.test(manifest.productVersion)
    || !['x64', 'arm64'].includes(manifest.architecture)) throw new Error('Invalid application payload identity')
  exact(manifest.archive, ['file', 'size', 'sha256'], 'archive fields')
  runtime.validateRelativePath(manifest.archive.file)
  if (manifest.archive.file.includes('/') || !manifest.archive.file.endsWith('.zip')
    || !Number.isSafeInteger(manifest.archive.size) || manifest.archive.size <= 0 || manifest.archive.size > MAX_ARCHIVE_BYTES
    || !/^[a-f0-9]{64}$/.test(manifest.archive.sha256)) throw new Error('Invalid application payload archive')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error('Invalid application payload inventory')
  const paths = new Set()
  let total = 0
  for (const file of manifest.files) {
    exact(file, ['path', 'size', 'sha256'], 'file fields')
    validatePayloadPath(file.path)
    const key = file.path.toLowerCase()
    if (paths.has(key)) throw new Error('Duplicate application payload path')
    paths.add(key)
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_EXPANDED_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid application payload file identity')
    total += file.size
    if (!Number.isSafeInteger(total) || total > MAX_EXPANDED_BYTES) throw new Error('Application payload exceeds expanded size limit')
  }
  for (const name of paths) {
    const segments = name.split('/')
    for (let count = 1; count < segments.length; count++) {
      if (paths.has(segments.slice(0, count).join('/'))) throw new Error('Application payload file conflicts with a directory')
    }
  }
  for (const name of application.REQUIRED_RUNTIME_FILES) if (!manifest.files.some(file => file.path === name && file.size > 0)) throw new Error('Application payload runtime is incomplete: ' + name)
  return manifest
}

function verifyApplicationPayload(archive, manifest) {
  validateManifest(manifest)
  u.assertFile(archive)
  if (path.basename(archive) !== manifest.archive.file || fs.statSync(archive).size !== manifest.archive.size
    || u.sha256(archive) !== manifest.archive.sha256) throw new Error('Application payload archive identity does not match')
  runtime.verifyArchive(archive, manifest.files)
  return manifest
}

function packApplicationPayload({ source, output, architecture, edition = application.EDITION, productVersion = application.VERSION }) {
  application.validateArchitectures([architecture])
  if (!source || !output) throw new Error('Application payload source and output are required')
  source = path.resolve(source)
  output = path.resolve(output)
  const relative = path.relative(source, output)
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Application payload output must be outside its source')
  if (!['concept', 'community'].includes(edition) || typeof productVersion !== 'string' || !VERSION.test(productVersion) || productVersion.length > 64) throw new Error('Invalid application payload identity')
  const name = 'SidekickAI-Application-' + productVersion + '-' + architecture
  const archive = path.join(output, name + '.zip')
  const manifestPath = path.join(output, name + '.manifest.json')
  if (fs.existsSync(archive) || fs.existsSync(manifestPath)) throw new Error('Application payload output already exists')
  const before = application.applicationFingerprint(source)
  const verified = application.verifyRuntime(source, architecture, { edition, productVersion })
  const nativeFiles = application.verifyNativeFiles(source, architecture)
  const files = runtime.fileInventory(source, { validate: validatePayloadPath })
  const packed = runtime.archiveFiles(source, archive, files)
  const manifest = validateManifest({ schemaVersion: 1, kind: 'application-payload', edition, productVersion, architecture,
    archive: { file: path.basename(archive), size: packed.size, sha256: packed.sha256 }, files })
  u.assertUnchanged(before, application.applicationFingerprint(source))
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return { architecture, path: archive, manifestPath, manifest, native: verified.native, nativeFiles, inputs: before }
}

function packApplicationPayloads({ applications, output, architectures = ['x64', 'arm64'] }) {
  application.validateArchitectures(architectures)
  return architectures.map(architecture => packApplicationPayload({
    source: path.join(applications, application.TARGETS[architecture].directory), output, architecture,
  }))
}

module.exports = { MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES, MAX_FILES, validatePayloadPath, validateManifest,
  verifyApplicationPayload, packApplicationPayload, packApplicationPayloads }
