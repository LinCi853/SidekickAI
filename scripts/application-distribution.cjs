'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const u = require('./uninstaller-build-utils.cjs')
const { localBuildEnvironment } = require('./local-build-config.cjs')

const PURPOSES = {
  body: 'sidekickai-application-body-v1',
  runtime: 'sidekickai-backup-runtime-v1',
  release: 'sidekickai-application-release-v1',
  channel: 'sidekickai-application-channel-v1',
}
const ARCHITECTURES = ['x64', 'arm64']
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILES = 5000
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/
const RELEASE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sha256 = file => u.sha256(file)

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  throw new Error('Unsupported application distribution JSON value')
}

function releaseChannel(version) {
  const match = typeof version === 'string' && version.length <= 64 && RELEASE_VERSION.exec(version)
  if (!match) throw new Error('Invalid application release product version')
  return match[1] || 'stable'
}

function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new Error('Invalid ' + name + ' fields')
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\:\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Unsafe application distribution path')
  return value
}

function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('Invalid application file inventory')
  const seen = new Set()
  let expandedBytes = 0
  for (const file of files) {
    exact(file, ['path', 'sizeBytes', 'sha256', 'executableArchitecture'], 'file')
    validateRelativePath(file.path)
    const key = file.path.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate application distribution path')
    seen.add(key)
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 4 * MAX_BYTES
      || !/^[a-f0-9]{64}$/.test(file.sha256) || file.executableArchitecture !== null
      && ![...ARCHITECTURES, 'anycpu'].includes(file.executableArchitecture)) {
      throw new Error('Invalid application file identity')
    }
    if (/\.exe$/i.test(file.path) && file.executableArchitecture === null) throw new Error('Executable files must declare their PE architecture')
    expandedBytes += file.sizeBytes
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 4 * MAX_BYTES) throw new Error('Expanded application exceeds the supported limit')
  }
  return { expandedBytes, fileCount: files.length }
}

function validateArchive(archive, expanded = false) {
  exact(archive, expanded ? ['sha256', 'sizeBytes', 'expandedBytes', 'fileCount'] : ['sha256', 'sizeBytes'], 'archive')
  if (!/^[a-f0-9]{64}$/.test(archive.sha256) || !Number.isSafeInteger(archive.sizeBytes)
    || archive.sizeBytes <= 0 || archive.sizeBytes > MAX_BYTES) throw new Error('Invalid application archive identity')
  if (expanded && (!Number.isSafeInteger(archive.expandedBytes) || archive.expandedBytes <= 0
    || archive.expandedBytes > 4 * MAX_BYTES || !Number.isSafeInteger(archive.fileCount)
    || archive.fileCount <= 0 || archive.fileCount > MAX_FILES)) throw new Error('Invalid expanded application bounds')
}

function validatePayload(payload, purpose) {
  const common = payload?.protocolVersion === 1 && payload.productId === 'sidekickai'
    && ['community', 'concept'].includes(payload.edition)
  if (!common) throw new Error('Invalid application distribution identity')
  if (purpose === PURPOSES.runtime) {
    exact(payload, ['protocolVersion', 'productId', 'edition', 'componentId', 'componentVersion', 'nativeArchitecture', 'archive',
      'files', 'exportProtocolVersion', 'recoveryProtocolVersion', 'entrypoints'], 'runtime')
    if (payload.componentId !== 'backup-runtime' || typeof payload.componentVersion !== 'string' || payload.componentVersion.length > 64 || !VERSION.test(payload.componentVersion)
      || !ARCHITECTURES.includes(payload.nativeArchitecture) || payload.exportProtocolVersion !== 1
      || payload.recoveryProtocolVersion !== 1) throw new Error('Invalid recovery component capability')
    validateArchive(payload.archive)
    validateFiles(payload.files)
    exact(payload.entrypoints, ['export', 'restore'], 'runtime entrypoints')
    for (const name of Object.values(payload.entrypoints)) {
      validateRelativePath(name)
      if (!payload.files.some(file => file.path === name)) throw new Error('Recovery entrypoint is missing')
    }
    if (!payload.files.some(file => file.path === 'node.exe' && file.executableArchitecture === payload.nativeArchitecture)
      || payload.files.some(file => file.executableArchitecture && file.executableArchitecture !== 'anycpu' && file.executableArchitecture !== payload.nativeArchitecture)) {
      throw new Error('Recovery runtime contains an incompatible native binary')
    }
    return payload
  }
  if (purpose === PURPOSES.body) {
    exact(payload, ['protocolVersion', 'productId', 'edition', 'productVersion', 'variant', 'platform', 'nativeArchitectures',
      'maintenanceProtocolVersion', 'recoveryProtocolVersion', 'archive', 'files', 'components'], 'body')
    if (typeof payload.productVersion !== 'string' || payload.productVersion.length > 64 || !VERSION.test(payload.productVersion) || payload.platform !== 'windows'
      || !['installed', 'portable'].includes(payload.variant) || payload.maintenanceProtocolVersion !== 1
      || payload.recoveryProtocolVersion !== 1 || !Array.isArray(payload.nativeArchitectures)
      || payload.nativeArchitectures.some(arch => !ARCHITECTURES.includes(arch))
      || new Set(payload.nativeArchitectures).size !== payload.nativeArchitectures.length
      || payload.nativeArchitectures.length !== (payload.variant === 'installed' ? 1 : 2)
      || payload.variant === 'portable' && payload.edition !== 'concept') throw new Error('Invalid application body capability')
    const bounds = validateFiles(payload.files)
    if (payload.variant === 'installed') {
      validateArchive(payload.archive, true)
      if (bounds.expandedBytes !== payload.archive.expandedBytes || bounds.fileCount !== payload.archive.fileCount) {
        throw new Error('Application body file bounds do not match')
      }
    } else if (payload.archive !== null) throw new Error('Portable proof must bind its immutable file inventory')
    if (payload.files.some(file => ['distribution-proof.json', 'body-proof.json'].includes(file.path.toLowerCase())
      || /^data(?:\/|$)/i.test(file.path) || file.executableArchitecture && file.executableArchitecture !== 'anycpu'
      && !payload.nativeArchitectures.includes(file.executableArchitecture))) {
      throw new Error('Application body contains proof, user data or another architecture')
    }
    if (!Array.isArray(payload.components) || payload.components.length !== payload.nativeArchitectures.length) {
      throw new Error('Application body is missing a recovery component')
    }
    const componentArchitectures = new Set()
    for (const component of payload.components) {
      exact(component, ['componentId', 'componentVersion', 'nativeArchitecture', 'archivePath', 'proofPath', 'sha256', 'sizeBytes'], 'component')
      if (component.componentId !== 'backup-runtime' || typeof component.componentVersion !== 'string' || component.componentVersion.length > 64 || !VERSION.test(component.componentVersion)
        || !payload.nativeArchitectures.includes(component.nativeArchitecture) || componentArchitectures.has(component.nativeArchitecture)
        || !/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.sizeBytes) || component.sizeBytes <= 0) {
        throw new Error('Invalid recovery component binding')
      }
      componentArchitectures.add(component.nativeArchitecture)
      validateRelativePath(component.archivePath)
      validateRelativePath(component.proofPath)
      const archive = payload.files.find(file => file.path === component.archivePath)
      if (!archive || archive.sha256 !== component.sha256 || archive.sizeBytes !== component.sizeBytes
        || !payload.files.some(file => file.path === component.proofPath)
        || component.archivePath === component.proofPath) throw new Error('Recovery dependency does not match the body')
    }
    return payload
  }
  if (![PURPOSES.release, PURPOSES.channel].includes(purpose)) throw new Error('Unsupported distribution signature purpose')
  if (purpose === PURPOSES.release && payload.channel !== releaseChannel(payload.productVersion)) {
    throw new Error('Release channel does not match its product version')
  }
  return payload
}

function publicTrust(root = path.resolve(__dirname, '..'), env = process.env) {
  env = localBuildEnvironment(root, env)
  const file = path.join(root, 'resources/oxy-deployment.json')
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const keys = JSON.parse(env.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON
    ?? JSON.stringify(config.distributionKeys ?? config.adminKeys ?? config.resourceKeys ?? []))
  if (!Array.isArray(keys) || !keys.length || keys.length > 16 || keys.some(key => !key
    || !/^[A-Za-z0-9_-]{8,80}$/.test(key.id) || key.publicKey?.kty !== 'OKP'
    || key.publicKey?.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(key.publicKey.x ?? '')
    || key.publicKey.d !== undefined || key.privateKey !== undefined)
    || new Set(keys.map(key => key.id)).size !== keys.length) throw new Error('Public application distribution trust is required')
  return keys
}

function loadLocalSigner(root = path.resolve(__dirname, '..'), env = process.env) {
  env = localBuildEnvironment(root, env)
  const trust = publicTrust(root, env)
  const keysFile = env.SIDEKICK_DISTRIBUTION_SIGNING_KEYS_FILE
    || path.join(root, 'services/oxy-policy/private/publication/keys.json')
  const trustFile = env.SIDEKICK_DISTRIBUTION_SIGNING_TRUST_FILE
    || path.join(root, 'services/oxy-policy/private/trust.json')
  if (!fs.existsSync(keysFile) || !fs.existsSync(trustFile)) throw new Error('A controlled application publication signer is required')
  const privateSet = JSON.parse(fs.readFileSync(keysFile, 'utf8'))
  const publishedSet = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
  if (privateSet.formatVersion !== 1 || publishedSet.formatVersion !== 1 || !privateSet.instanceId
    || privateSet.instanceId !== publishedSet.instanceId || !Array.isArray(privateSet.adminKeys)
    || !Array.isArray(publishedSet.adminKeys)) throw new Error('Publication signing identity does not match its public trust')
  for (const candidate of privateSet.adminKeys) {
    const expected = trust.find(key => key.id === candidate.id)
    const advertised = publishedSet.adminKeys.find(key => key.id === candidate.id)
    if (!expected || !advertised || canonicalJson(expected.publicKey) !== canonicalJson(advertised.publicKey)) continue
    const privateKey = crypto.createPrivateKey({ key: candidate.privateKey, format: 'jwk' })
    const publicKey = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
    if (canonicalJson(publicKey) !== canonicalJson(expected.publicKey)) throw new Error('Publication signer does not match build trust')
    return { id: candidate.id, privateKey, trust, source: 'controlled-local-publication' }
  }
  throw new Error('No publication admin signing identity matches build trust')
}

function signEnvelope(payload, purpose, signer) {
  validatePayload(payload, purpose)
  const header = Buffer.from(canonicalJson({ alg: 'EdDSA', kid: signer.id, typ: purpose })).toString('base64url')
  const body = Buffer.from(canonicalJson(payload)).toString('base64url')
  const input = header + '.' + body
  const signature = input + '.' + crypto.sign(null, Buffer.from(input), signer.privateKey).toString('base64url')
  return verifyEnvelope({ payload, signature }, purpose, signer.trust)
}

function verifyEnvelope(envelope, purpose, trust) {
  exact(envelope, ['payload', 'signature'], 'signed envelope')
  if (typeof envelope.signature !== 'string' || envelope.signature.length > 4 * 1024 * 1024) throw new Error('Invalid distribution signature')
  const parts = envelope.signature.split('.')
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid CompactJWS')
  const decode = part => {
    const bytes = Buffer.from(part, 'base64url')
    if (bytes.toString('base64url') !== part) throw new Error('Noncanonical CompactJWS encoding')
    return bytes
  }
  const header = JSON.parse(decode(parts[0]).toString('utf8'))
  exact(header, ['alg', 'kid', 'typ'], 'signature header')
  if (header.alg !== 'EdDSA' || header.typ !== purpose) throw new Error('Distribution signature purpose mismatch')
  const key = trust.find(entry => entry.id === header.kid)
  if (!key) throw new Error('Distribution signer is not trusted')
  const body = decode(parts[1])
  if (!body.equals(Buffer.from(canonicalJson(envelope.payload)))) throw new Error('Distribution signature body mismatch')
  const signature = decode(parts[2])
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey({ key: key.publicKey, format: 'jwk' }), signature)) throw new Error('Distribution signature verification failed')
  validatePayload(envelope.payload, purpose)
  return envelope
}

function fileInventory(directory, { exclude = [], prefix = '' } = {}) {
  const omitted = new Set(exclude)
  const files = []
  for (const file of u.listFiles(directory, new Set())) {
    const relative = path.relative(directory, file).replaceAll('\\', '/')
    if (omitted.has(relative) || [...omitted].some(name => relative.startsWith(name + '/'))) continue
    const name = prefix + relative
    validateRelativePath(name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Distribution files must be regular files')
    let executableArchitecture = null
    if (/\.(?:exe|dll|node)$/i.test(relative)) {
      const bytes = fs.readFileSync(file)
      try { executableArchitecture = u.peInfo(bytes).arch } catch (error) {
        const managed = fs.existsSync(path.join(__dirname, 'build-observation-helper.cjs'))
          ? require('./build-observation-helper.cjs') : require('./build-startup-helper.cjs')
        managed.verifyManagedArchitecture(bytes)
        executableArchitecture = 'anycpu'
      }
    }
    files.push({ path: name, sizeBytes: stat.size, sha256: sha256(file), executableArchitecture })
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  validateFiles(files)
  return files
}

function applicationConfiguration(root = path.resolve(__dirname, '..'), env = process.env) {
  const cloud = require('./oxy-build-config.cjs').cloudBuildEnvironment(env, path.join(root, 'resources/oxy-deployment.json'))
  return { origin: cloud.SIDEKICK_OXY_ORIGIN, keys: publicTrust(root, env),
    resourceKeys: JSON.parse(cloud.SIDEKICK_RESOURCE_TRUST_KEYS_JSON) }
}

function writeApplicationConfiguration(directory, configuration) {
  const resources = path.join(directory, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(resources, 'application-trust.json'), canonicalJson(configuration.keys) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(resources, 'resource-trust.json'), canonicalJson(configuration.resourceKeys) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(resources, 'oxy-service.json'), canonicalJson({ origin: configuration.origin }) + '\n', { flag: 'wx' })
}

function archiveFiles(directory, destination, files, { executable = process.env.SIDEKICK_7Z || 'C:/Program Files/7-Zip/7z.exe' } = {}) {
  if (fs.existsSync(destination)) throw new Error('Distribution archive already exists')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const list = destination + '.files.txt'
  fs.writeFileSync(list, files.map(file => file.path).join('\n') + '\n', { flag: 'wx' })
  try {
    const result = spawnSync(executable, ['a', '-tzip', '-mx=5', '-y', '-scsUTF-8', destination, '@' + list],
      { cwd: directory, stdio: 'pipe', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('Distribution ZIP creation failed: ' + (result.error?.message || result.status))
    const verified = spawnSync(executable, ['t', destination], { stdio: 'pipe', windowsHide: true })
    if (verified.error || verified.status !== 0) throw new Error('Distribution ZIP verification failed')
  } finally { fs.unlinkSync(list) }
  return { path: destination, sha256: sha256(destination), sizeBytes: fs.statSync(destination).size }
}

function recoveryComponent(directory, arch, edition, signer, root = path.resolve(__dirname, '..'), runtimeRoot = path.join(root, 'build/backup-runtime')) {
  const contract = require('./component-contract.cjs').readContract(root)
  const source = path.join(runtimeRoot, 'win-' + arch + '.zip')
  const contents = path.join(runtimeRoot, arch)
  u.assertFile(source)
  const files = fileInventory(contents)
  const payload = { protocolVersion: 1, productId: 'sidekickai', edition, componentId: 'backup-runtime',
    componentVersion: contract.recoveryComponentVersion, nativeArchitecture: arch,
    archive: { sha256: sha256(source), sizeBytes: fs.statSync(source).size }, files,
    exportProtocolVersion: 1, recoveryProtocolVersion: 1,
    entrypoints: { export: 'export.mjs', restore: 'sidekick-backup.cjs' } }
  const proof = signEnvelope(payload, PURPOSES.runtime, signer)
  const maintenance = path.join(directory, 'maintenance')
  fs.mkdirSync(maintenance, { recursive: true })
  fs.copyFileSync(source, path.join(maintenance, 'backup-runtime.zip'), fs.constants.COPYFILE_EXCL)
  fs.writeFileSync(path.join(maintenance, 'runtime-proof.json'), canonicalJson(proof) + '\n', { flag: 'wx' })
  return { componentId: 'backup-runtime', componentVersion: contract.recoveryComponentVersion, nativeArchitecture: arch,
    archivePath: 'maintenance/backup-runtime.zip', proofPath: 'maintenance/runtime-proof.json',
    sha256: payload.archive.sha256, sizeBytes: payload.archive.sizeBytes }
}

function bodyPayload({ edition, version, variant, architectures, directory, archive, components }) {
  const files = fileInventory(directory, { exclude: ['distribution-proof.json', 'data'] })
  const bounds = validateFiles(files)
  return validatePayload({ protocolVersion: 1, productId: 'sidekickai', edition, productVersion: version,
    variant, platform: 'windows', nativeArchitectures: architectures, maintenanceProtocolVersion: 1,
    recoveryProtocolVersion: 1, archive: variant === 'installed'
      ? { sha256: sha256(archive), sizeBytes: fs.statSync(archive).size, ...bounds } : null, files, components }, PURPOSES.body)
}

function packagePayload(archive, proof, destination, signer) {
  verifyEnvelope(proof, PURPOSES.body, signer.trust)
  if (proof.payload.variant !== 'installed' || proof.payload.archive.sha256 !== sha256(archive)
    || proof.payload.archive.sizeBytes !== fs.statSync(archive).size) throw new Error('Signed body does not match the inner archive')
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), 'payload-envelope-'))
  try {
    fs.copyFileSync(archive, path.join(staging, 'application.zip'), fs.constants.COPYFILE_EXCL)
    fs.writeFileSync(path.join(staging, 'body-proof.json'), canonicalJson(proof) + '\n', { flag: 'wx' })
    return archiveFiles(staging, destination, fileInventory(staging))
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}

module.exports = { PURPOSES, ARCHITECTURES, MAX_BYTES, MAX_FILES, FIXED_TIME, hash, sha256, canonicalJson,
  releaseChannel, validateRelativePath, validateFiles, validatePayload, publicTrust, loadLocalSigner, signEnvelope, verifyEnvelope,
  fileInventory, archiveFiles, recoveryComponent, bodyPayload, packagePayload,
  applicationConfiguration, writeApplicationConfiguration }
