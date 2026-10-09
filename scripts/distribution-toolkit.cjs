'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')
const archive = require('./application-archive.cjs')
const runtime = require('./application-runtime.cjs')
const u = require('./build-utils.cjs')
const TRUSTED_RELEASE = require('./distribution-toolkit-release.cjs')

const INTERFACE_VERSION = 1
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_FILES = 1024
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/
const ROLES = ['assembler', 'wizard-template', 'uninstaller-template', 'recovery-template', 'backup-runtime', 'product-contract', 'license']

function fields(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Invalid distribution toolkit fields')
}

function validVersion(value) {
  return typeof value === 'string' && value.length <= 64 && VERSION.test(value)
}

function digest(value) {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value)
}

function validatePublicIdentity(value) {
  fields(value, ['id', 'publicKey'])
  fields(value.publicKey, ['kty', 'crv', 'x'])
  const key = value.publicKey
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$(?![\s\S])/.test(value.id)
    || key.kty !== 'OKP' || key.crv !== 'Ed25519' || typeof key.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.x)
    || Buffer.from(key.x, 'base64url').toString('base64url') !== key.x
    || value.id !== 'self-built-' + u.hash(runtime.canonicalJson(key))) throw new Error('Invalid distribution public identity')
  return value
}

function location(value, allowLoopback = false) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid toolkit archive location')
  let url
  try { url = new URL(value) } catch { throw new Error('Toolkit archive location must be an absolute URL') }
  if (url.username || url.password || url.hash) throw new Error('Toolkit archive location cannot contain credentials or a fragment')
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && url.protocol !== 'file:' && !(allowLoopback && url.protocol === 'http:' && loopback)) {
    throw new Error('Toolkit downloads require HTTPS or an explicitly selected local file')
  }
  if (url.protocol === 'file:' && url.hostname) throw new Error('Network file locations are not supported')
  return url
}

function validateReference(reference, options = {}) {
  fields(reference, ['schemaVersion', 'toolkitVersion', 'interfaceVersion', 'archive'])
  if (reference.schemaVersion !== 1 || reference.interfaceVersion !== INTERFACE_VERSION || !validVersion(reference.toolkitVersion)) {
    throw new Error('Unsupported distribution toolkit reference')
  }
  fields(reference.archive, ['size', 'sha256'], ['url', 'path'])
  if (Object.hasOwn(reference.archive, 'url') === Object.hasOwn(reference.archive, 'path')) {
    throw new Error('Toolkit archive requires exactly one URL or project-relative path')
  }
  if (!Number.isSafeInteger(reference.archive.size) || reference.archive.size < 1 || reference.archive.size > MAX_ARCHIVE_BYTES
    || !digest(reference.archive.sha256)) throw new Error('Invalid distribution toolkit archive identity')
  if (reference.toolkitVersion !== TRUSTED_RELEASE.toolkitVersion) {
    throw new Error('Distribution toolkit version must match the trusted release ' + TRUSTED_RELEASE.toolkitVersion)
  }
  if (reference.archive.size !== TRUSTED_RELEASE.size) {
    throw new Error('Distribution toolkit archive size must match the trusted release (' + TRUSTED_RELEASE.size + ' bytes)')
  }
  if (reference.archive.sha256 !== TRUSTED_RELEASE.sha256) {
    throw new Error('Distribution toolkit archive SHA-256 must match the trusted release ' + TRUSTED_RELEASE.sha256)
  }
  if (Object.hasOwn(reference.archive, 'path')) runtime.validateRelativePath(reference.archive.path)
  else location(reference.archive.url, options.allowLoopback)
  return reference
}

function readReference(root, options = {}) {
  const file = path.resolve(options.referenceFile || options.env?.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
    || process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE || path.join(root, 'maintenance/distribution-toolkit.json'))
  if (!fs.existsSync(file)) throw new Error('安装维护待组装包尚未配置；请提供发布清单 SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE。')
  u.assertFile(file)
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) throw new Error('Distribution toolkit reference exceeds its size limit')
  const bytes = fs.readFileSync(file)
  let reference
  try { reference = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Cannot parse distribution toolkit reference') }
  return { file, sha256: u.hash(bytes), reference: validateReference(reference, options) }
}

function validateManifest(manifest, reference) {
  fields(manifest, ['schemaVersion', 'kind', 'toolkitVersion', 'interfaceVersion', 'maintenanceComponentVersion',
    'recoveryComponentVersion', 'host', 'assembler', 'capabilities', 'placeholderTrust', 'files'], ['installationConfigurationVersion'])
  validatePublicIdentity(manifest.placeholderTrust)
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'sidekick-distribution-toolkit'
    || manifest.interfaceVersion !== INTERFACE_VERSION || manifest.toolkitVersion !== reference.toolkitVersion
    || !validVersion(manifest.maintenanceComponentVersion) || !validVersion(manifest.recoveryComponentVersion)) {
    throw new Error('Distribution toolkit identity does not match its pinned reference')
  }
  if (manifest.installationConfigurationVersion !== undefined && manifest.installationConfigurationVersion !== 1) {
    throw new Error('Unsupported installation configuration interface')
  }
  fields(manifest.host, ['platform', 'architecture'])
  if (manifest.host.platform !== 'windows' || !['x64', 'arm64'].includes(manifest.host.architecture)) throw new Error('Unsupported distribution toolkit host')
  runtime.validateRelativePath(manifest.assembler)
  if (!manifest.assembler.endsWith('.exe') || !Array.isArray(manifest.capabilities) || !manifest.capabilities.length) {
    throw new Error('Distribution toolkit has no assembly capability')
  }
  const capabilities = new Set()
  for (const capability of manifest.capabilities) {
    fields(capability, ['edition', 'mode', 'authority', 'architectures'])
    if (!['concept', 'community'].includes(capability.edition) || !['offline', 'online'].includes(capability.mode)
      || !['official', 'self-built'].includes(capability.authority) || !Array.isArray(capability.architectures)
      || !capability.architectures.length || capability.architectures.length > 2
      || capability.architectures.some(arch => !['x64', 'arm64'].includes(arch))
      || new Set(capability.architectures).size !== capability.architectures.length) throw new Error('Invalid distribution toolkit capability')
    const key = [capability.edition, capability.mode, capability.authority].join(':')
    if (capabilities.has(key)) throw new Error('Duplicate distribution toolkit capability')
    capabilities.add(key)
  }
  if (!manifest.capabilities.some(capability => capability.edition === 'concept' && capability.mode === 'offline'
    && capability.authority === 'self-built' && ['x64', 'arm64'].every(arch => capability.architectures.includes(arch)))) {
    throw new Error('Distribution toolkit does not support dual-architecture self-built concept installers')
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES) throw new Error('Invalid distribution toolkit inventory')
  const names = new Set()
  let expanded = 0
  for (const file of manifest.files) {
    fields(file, ['path', 'role', 'architecture', 'size', 'sha256'], ['edition', 'authority'])
    runtime.validateRelativePath(file.path)
    if (file.path.toLowerCase() === 'toolkit-manifest.json' || names.has(file.path.toLowerCase())) throw new Error('Duplicate distribution toolkit path')
    names.add(file.path.toLowerCase())
    if (!ROLES.includes(file.role) || ![null, 'x64', 'arm64'].includes(file.architecture)
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARCHIVE_BYTES || !digest(file.sha256)
      || file.edition !== undefined && !['concept', 'community'].includes(file.edition)
      || file.authority !== undefined && !['official', 'self-built'].includes(file.authority)) throw new Error('Invalid distribution toolkit file identity')
    expanded += file.size
    if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED_BYTES) throw new Error('Distribution toolkit exceeds its expanded size limit')
  }
  for (const name of names) {
    const parts = name.split('/')
    for (let count = 1; count < parts.length; count++) if (names.has(parts.slice(0, count).join('/'))) throw new Error('Toolkit file conflicts with a directory')
  }
  const assemblers = manifest.files.filter(file => file.role === 'assembler')
  if (assemblers.length !== 1 || assemblers[0].path !== manifest.assembler || assemblers[0].architecture !== manifest.host.architecture) {
    throw new Error('Distribution toolkit assembler is not uniquely registered')
  }
  for (const role of ['product-contract', 'license']) {
    if (!manifest.files.some(file => file.role === role)) throw new Error('Distribution toolkit is missing its ' + role + ' resource')
  }
  for (const arch of ['x64', 'arm64']) {
    for (const role of ['wizard-template', 'uninstaller-template', 'recovery-template', 'backup-runtime']) {
      if (!manifest.files.some(file => file.role === role && file.architecture === arch
        && (file.edition === undefined || file.edition === 'concept') && (file.authority === undefined || file.authority === 'self-built'))) {
        throw new Error('Distribution toolkit is missing a self-built maintenance component: ' + arch + '/' + role)
      }
    }
  }
  return manifest
}

function projectArchive(root, reference) {
  if (!root) throw new Error('Project-relative toolkit archives require a workspace root')
  root = path.resolve(root)
  const file = path.join(root, ...runtime.validateRelativePath(reference.archive.path).split('/'))
  for (let current = file; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Project toolkit archive cannot use filesystem links')
  }
  u.assertFile(file)
  if (fs.statSync(file).size !== reference.archive.size || u.sha256(file) !== reference.archive.sha256) {
    throw new Error('Project toolkit archive does not match its pinned size and SHA-256')
  }
  return file
}

async function download(reference, destination, options = {}) {
  const url = Object.hasOwn(reference.archive, 'path') ? pathToFileURL(projectArchive(options.root, reference))
    : location(reference.archive.url, options.allowLoopback)
  let input
  if (url.protocol === 'file:') {
    const source = fileURLToPath(url)
    u.assertFile(source)
    input = fs.createReadStream(source)
  } else {
    const response = await (options.fetch || fetch)(url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) })
    if (!response.ok || !response.body) throw new Error('Distribution toolkit download failed: HTTP ' + response.status)
    location(response.url || url.href, options.allowLoopback)
    input = Readable.fromWeb(response.body)
  }
  let written = 0
  const limit = new Transform({ transform(chunk, encoding, callback) {
    written += chunk.length
    callback(written > reference.archive.size ? new Error('Toolkit download exceeds its declared size') : null, chunk)
  } })
  await pipeline(input, limit, fs.createWriteStream(destination, { flags: 'wx' }))
  if (written !== reference.archive.size || u.sha256(destination) !== reference.archive.sha256) throw new Error('Toolkit archive does not match its pinned size and SHA-256')
}

async function readArchiveManifest(file, reference) {
  const zip = await yauzl.openPromise(file, { autoClose: false, validateEntrySizes: true, strictFileNames: true })
  let bytes
  try {
    if (zip.entryCount > MAX_FILES * 2 + 1) throw new Error('Distribution toolkit contains too many ZIP entries')
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== 'toolkit-manifest.json') continue
      if (bytes || entry.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('Invalid toolkit manifest ZIP entry')
      const chunks = []
      let size = 0
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        size += chunk.length
        if (size > MAX_MANIFEST_BYTES) throw new Error('Toolkit manifest exceeds its size limit')
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks)
    }
  } finally { await archive.closeArchive(zip) }
  if (!bytes) throw new Error('Distribution toolkit manifest is missing')
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Cannot parse toolkit manifest') }
  validateManifest(manifest, reference)
  const files = [...manifest.files.map(({ path: name, size, sha256 }) => ({ path: name, size, sha256 })),
    { path: 'toolkit-manifest.json', size: bytes.length, sha256: u.hash(bytes) }]
  await archive.verifyArchive(file, files)
  return { manifest, files }
}

async function extract(file, directory) {
  fs.mkdirSync(directory)
  const zip = await yauzl.openPromise(file, { autoClose: false, validateEntrySizes: true, strictFileNames: true })
  try {
    for await (const entry of zip.eachEntry()) {
      const isDirectory = entry.fileName.endsWith('/')
      runtime.validateRelativePath(isDirectory ? entry.fileName.slice(0, -1) : entry.fileName)
      const target = path.join(directory, ...entry.fileName.split('/'))
      if (isDirectory) { fs.mkdirSync(target, { recursive: true }); continue }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await pipeline(await zip.openReadStreamPromise(entry), fs.createWriteStream(target, { flags: 'wx' }))
    }
  } finally { await archive.closeArchive(zip) }
}

function verifyDirectory(directory, inventory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Toolkit root must be a regular directory')
  const files = u.listFiles(directory, new Set())
  const actual = files.map(file => path.relative(directory, file).replaceAll('\\', '/')).sort()
  const expected = inventory.files.map(file => file.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Extracted toolkit contains missing or unexpected files')
  for (const file of inventory.files) {
    const target = path.join(directory, ...file.path.split('/'))
    u.assertFile(target)
    if (fs.statSync(target).size !== file.size || u.sha256(target) !== file.sha256) throw new Error('Extracted toolkit file does not match its pinned identity: ' + file.path)
  }
  for (const file of inventory.manifest.files.filter(file => /\.(?:exe|dll|node)$/i.test(file.path))) {
    if (file.architecture === null || u.peInfo(fs.readFileSync(path.join(directory, ...file.path.split('/')))).arch !== file.architecture) {
      throw new Error('Distribution toolkit native architecture does not match its inventory')
    }
  }
  return u.fingerprint(directory, files)
}

async function prepareToolkit(root, options = {}) {
  const selected = options.reference ? { reference: validateReference(options.reference, options), file: null } : readReference(root, options)
  const reference = selected.reference
  const projectRoot = Object.hasOwn(reference.archive, 'path') ? path.resolve(root) : null
  if (projectRoot) projectArchive(projectRoot, reference)
  const parent = path.join(root, 'build/component-cache/distribution-toolkit')
  fs.mkdirSync(parent, { recursive: true })
  const destination = path.join(parent, reference.archive.sha256)
  let directory = destination
  const reused = fs.existsSync(destination)
  if (!reused) {
    directory = fs.mkdtempSync(path.join(parent, 'download-'))
    console.log('[toolkit] Downloading pinned maintenance components ' + reference.toolkitVersion)
    await download(reference, path.join(directory, 'archive.zip'), { ...options, root })
  }
  const zip = path.join(directory, 'archive.zip')
  u.assertFile(zip)
  if (fs.statSync(zip).size !== reference.archive.size || u.sha256(zip) !== reference.archive.sha256) throw new Error('Cached toolkit does not match its pinned archive')
  const inventory = await readArchiveManifest(zip, reference)
  const toolkitDirectory = path.join(directory, 'toolkit')
  if (!reused) await extract(zip, toolkitDirectory)
  const inputs = verifyDirectory(toolkitDirectory, inventory)
  if (!reused) fs.renameSync(directory, destination)
  const toolkit = { reference, referenceFile: selected.file, referenceSha256: selected.sha256, projectRoot,
    directory: path.join(destination, 'toolkit'), archive: path.join(destination, 'archive.zip'),
    manifest: inventory.manifest, files: inventory.files, inputs, reused }
  assertUnchanged(toolkit)
  return toolkit
}

function assertUnchanged(toolkit) {
  if (toolkit.projectRoot) projectArchive(toolkit.projectRoot, toolkit.reference)
  if (toolkit.referenceFile) {
    u.assertFile(toolkit.referenceFile)
    if (u.sha256(toolkit.referenceFile) !== toolkit.referenceSha256) throw new Error('Distribution toolkit reference changed during assembly')
  }
  u.assertFile(toolkit.archive)
  if (fs.statSync(toolkit.archive).size !== toolkit.reference.archive.size || u.sha256(toolkit.archive) !== toolkit.reference.archive.sha256) {
    throw new Error('Distribution toolkit archive changed during assembly')
  }
  u.assertUnchanged(toolkit.inputs, verifyDirectory(toolkit.directory, toolkit))
}

module.exports = { INTERFACE_VERSION, MAX_MANIFEST_BYTES, MAX_ARCHIVE_BYTES, fields, validVersion, digest,
  validatePublicIdentity, validateReference, readReference, validateManifest, readArchiveManifest, prepareToolkit, assertUnchanged }
