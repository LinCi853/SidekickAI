'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const toolkitApi = require('./distribution-toolkit.cjs')
const payloadApi = require('./application-payload.cjs')
const runtime = require('./application-runtime.cjs')
const u = require('./build-utils.cjs')
const MAX_RESULT_BYTES = 4 * 1024 * 1024
const MAX_APPLICATION_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_CONFIGURATION_BYTES = 32 * 1024
const CONFIGURATION_PATH = 'inputs/installation-configuration.json'

function readInstallationConfiguration(root, toolkit) {
  const file = path.join(root, 'maintenance/installation-configuration.json')
  if (!fs.existsSync(file)) return null
  u.assertFile(file)
  const raw = fs.readFileSync(file)
  if (raw.length > MAX_CONFIGURATION_BYTES) throw new Error('Installation configuration exceeds its size limit')
  const value = JSON.parse(raw.toString('utf8'))
  toolkitApi.fields(value, ['schemaVersion', 'edition', 'options'])
  if (value.schemaVersion !== 1 || value.edition !== 'concept' || !value.options || Array.isArray(value.options)
    || typeof value.options !== 'object' || Object.entries(value.options).some(([key, selected]) =>
      !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || typeof selected !== 'boolean' && (typeof selected !== 'string' || selected.length > 128))) {
    throw new Error('Invalid installation configuration')
  }
  if (toolkit.manifest.installationConfigurationVersion !== 1) {
    throw new Error('The pinned toolkit cannot accept installation defaults; select a compatible toolkit before building')
  }
  const bytes = Buffer.from(runtime.canonicalJson(value) + '\n')
  return { file, value, bytes, sha256: u.hash(bytes), originalSha256: u.hash(raw) }
}

function assertConfigurationUnchanged(configuration, root) {
  if (!configuration) {
    if (fs.existsSync(path.join(root, 'maintenance/installation-configuration.json'))) {
      throw new Error('Installation configuration changed during assembly')
    }
    return
  }
  u.assertFile(configuration.file)
  if (u.sha256(configuration.file) !== configuration.originalSha256) throw new Error('Installation configuration changed during assembly')
}

function invoke(toolkit, args, options = {}) {
  toolkitApi.assertUnchanged(toolkit)
  const result = (options.spawn || spawnSync)(path.join(toolkit.directory, ...toolkit.manifest.assembler.split('/')), args,
    { cwd: toolkit.directory, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  toolkitApi.assertUnchanged(toolkit)
  if (result.error || result.status !== 0) throw new Error('二进制组装工具执行失败：' + (result.error?.message || result.stderr?.trim() || result.status))
  const last = result.stdout?.trim().split(/\r?\n/).at(-1)
  try { return JSON.parse(last) } catch { throw new Error('二进制组装工具没有返回有效的 JSON 结果。') }
}

function inspectToolkit(toolkit, options = {}) {
  const result = invoke(toolkit, ['inspect', '--toolkit', toolkit.directory], options)
  if (result.interfaceVersion !== toolkitApi.INTERFACE_VERSION || result.toolkitVersion !== toolkit.reference.toolkitVersion
    || result.verified !== true || runtime.canonicalJson(result.capabilities) !== runtime.canonicalJson(toolkit.manifest.capabilities)) {
    throw new Error('Distribution toolkit inspection does not match its pinned capability')
  }
  if (result.installationConfigurationVersion !== toolkit.manifest.installationConfigurationVersion) {
    throw new Error('Distribution toolkit configuration capability does not match its pinned manifest')
  }
  return result
}

async function preflight({ root, toolkitOptions = {}, invokeOptions = {} }) {
  if ((toolkitOptions.platform || process.platform) !== 'win32') throw new Error('完整安装包构建需要 Windows 二进制组装工具。')
  const toolkit = await toolkitApi.prepareToolkit(root, toolkitOptions)
  inspectToolkit(toolkit, invokeOptions)
  readInstallationConfiguration(root, toolkit)
  return toolkit
}

function inputIdentity(payloads, edition, productVersion) {
  if (!Array.isArray(payloads) || payloads.length !== 2 || edition !== 'concept') throw new Error('Self-built assembly requires both concept application payloads')
  const inputs = {}, manifests = {}, files = [], expected = new Map()
  for (const arch of ['x64', 'arm64']) {
    const matches = payloads.filter(value => value.architecture === arch)
    if (matches.length !== 1) throw new Error('Self-built assembly requires one payload per architecture')
    const item = matches[0]
    u.assertFile(item.manifestPath)
    if (fs.statSync(item.manifestPath).size > MAX_APPLICATION_MANIFEST_BYTES) throw new Error('Application manifest exceeds its size limit')
    const manifestBytes = fs.readFileSync(item.manifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    payloadApi.verifyApplicationPayload(item.path, manifest)
    if (manifest.edition !== edition || manifest.productVersion !== productVersion || manifest.architecture !== arch) throw new Error('Assembly input identity does not match the application workspace')
    manifests[arch] = path.resolve(item.manifestPath)
    inputs[arch] = { manifestSha256: u.hash(manifestBytes), archiveSha256: manifest.archive.sha256 }
    files.push(path.resolve(item.manifestPath), path.resolve(item.path))
    expected.set(path.resolve(item.manifestPath), inputs[arch].manifestSha256)
    expected.set(path.resolve(item.path), inputs[arch].archiveSha256)
  }
  const base = path.dirname(files[0])
  const fingerprint = u.fingerprint(base, files)
  if (fingerprint.entries.some(file => expected.get(path.resolve(base, file.path)) !== file.sha256)) throw new Error('Assembly inputs changed during validation')
  return { inputs, manifests, fingerprint, files }
}

function validateResult(result, toolkit, output, identity) {
  toolkitApi.fields(result, ['interfaceVersion', 'toolkitVersion', 'edition', 'mode', 'productVersion', 'authority',
    'issuerKeyId', 'issuerFingerprint', 'inputs', 'artifacts'], ['schemaVersion', 'toolkitManifestSha256', 'publicIdentity', 'verified', 'installationConfigurationSha256'])
  if (!result || result.interfaceVersion !== toolkitApi.INTERFACE_VERSION || result.toolkitVersion !== toolkit.reference.toolkitVersion
    || result.edition !== identity.edition || result.mode !== 'offline' || result.authority !== 'self-built'
    || result.productVersion !== identity.productVersion || typeof result.issuerKeyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(result.issuerKeyId)
    || !toolkitApi.digest(result.issuerFingerprint)
    || runtime.canonicalJson(result.inputs) !== runtime.canonicalJson(identity.inputs)) throw new Error('Assembled installer identity does not match its requested inputs')
  if (result.installationConfigurationSha256 !== identity.installationConfigurationSha256
    || result.installationConfigurationSha256 !== undefined && !toolkitApi.digest(result.installationConfigurationSha256)) {
    throw new Error('Assembled installation configuration does not match its requested defaults')
  }
  if (!Array.isArray(result.artifacts) || result.artifacts.length !== 2) throw new Error('Assembly must produce two offline installers')
  const names = new Set()
  const installers = []
  for (const arch of ['x64', 'arm64']) {
    const matches = result.artifacts.filter(file => file.role === 'offline-installer' && file.architecture === arch)
    if (matches.length !== 1) throw new Error('Assembly must produce one installer per architecture')
    const item = matches[0]
    toolkitApi.fields(item, ['path', 'role', 'architecture', 'size', 'sha256'])
    runtime.validateRelativePath(item.path)
    if (!item.path.endsWith('.exe') || names.has(item.path.toLowerCase()) || !Number.isSafeInteger(item.size) || item.size <= 0
      || item.size > 2 * 1024 * 1024 * 1024 || !toolkitApi.digest(item.sha256)) throw new Error('Invalid assembled installer inventory')
    names.add(item.path.toLowerCase())
    const file = path.join(output, ...item.path.split('/'))
    for (let current = path.dirname(file); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory()) throw new Error('Assembly output cannot contain linked directories')
      if (current === output) break
      if (current === path.dirname(current)) throw new Error('Assembly output leaves its requested directory')
    }
    u.assertFile(file)
    if (fs.statSync(file).size !== item.size || u.sha256(file) !== item.sha256 || u.peInfo(fs.readFileSync(file)).arch !== arch) {
      throw new Error('Assembled installer bytes do not match its result')
    }
    installers.push({ architecture: arch, path: file, sha256: item.sha256, size: item.size, authority: 'self-built' })
  }
  return installers
}

function retainedInputs(directory, input) {
  const files = []
  for (const arch of ['x64', 'arm64']) {
    const manifestPath = 'inputs/' + arch + '/application.manifest.json'
    const manifestFile = path.join(directory, ...manifestPath.split('/'))
    u.assertFile(manifestFile)
    if (fs.statSync(manifestFile).size > MAX_APPLICATION_MANIFEST_BYTES) throw new Error('Retained application manifest exceeds its size limit')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    payloadApi.validateManifest(manifest)
    const archivePath = 'inputs/' + arch + '/' + manifest.archive.file
    for (const [relative, sha256] of [[manifestPath, input.inputs[arch].manifestSha256], [archivePath, input.inputs[arch].archiveSha256]]) {
      const file = path.join(directory, ...relative.split('/'))
      for (let current = path.dirname(file); ; current = path.dirname(current)) {
        const stat = fs.lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Retained assembly inputs cannot contain linked directories')
        if (current === directory) break
        if (current === path.dirname(current)) throw new Error('Retained assembly inputs leave the output directory')
      }
      u.assertFile(file)
      if (u.sha256(file) !== sha256) throw new Error('Retained assembly inputs do not match the original payloads')
      files.push({ path: relative, file, architecture: arch, size: fs.statSync(file).size, sha256 })
    }
  }
  if (input.installationConfigurationSha256 !== undefined) {
    const file = path.join(directory, ...CONFIGURATION_PATH.split('/'))
    u.assertFile(file)
    if (fs.statSync(file).size > MAX_CONFIGURATION_BYTES || u.sha256(file) !== input.installationConfigurationSha256) {
      throw new Error('Retained installation configuration does not match its requested defaults')
    }
    files.push({ path: CONFIGURATION_PATH, file, architecture: null, size: fs.statSync(file).size, sha256: input.installationConfigurationSha256 })
  }
  return files
}

async function assemble({ root, output, payloads, edition, productVersion, toolkit, toolkitOptions = {}, invokeOptions = {}, identityStore }) {
  toolkit ||= await preflight({ root, toolkitOptions, invokeOptions })
  const configuration = readInstallationConfiguration(root, toolkit)
  const input = inputIdentity(payloads, edition, productVersion)
  const source = { edition, productVersion, inputs: input.inputs,
    ...(configuration ? { installationConfigurationSha256: configuration.sha256 } : {}) }
  const directory = path.resolve(output, 'installers')
  if (fs.existsSync(directory)) throw new Error('Installer assembly output already exists')
  const request = { schemaVersion: 1, toolkitDirectory: toolkit.directory, toolkitVersion: toolkit.reference.toolkitVersion,
    edition, mode: 'offline', authority: 'self-built', payloads: input.manifests,
    identityStore: path.resolve(identityStore || path.join(root, 'local/self-build-identity.json')), outputDirectory: directory,
    ...(configuration ? { installationConfiguration: configuration.value } : {}) }
  fs.mkdirSync(output, { recursive: true })
  const requestFile = path.resolve(output, 'assembly-request.json')
  fs.writeFileSync(requestFile, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' })
  console.log('[assembly] Building self-built offline installers with pinned binary components')
  const response = invoke(toolkit, ['assemble', '--request', requestFile], invokeOptions)
  assertConfigurationUnchanged(configuration, root)
  const resultFile = path.join(directory, 'assembly-result.json')
  if (!response || response.schemaVersion !== 1 || typeof response.outputDirectory !== 'string' || typeof response.resultFile !== 'string'
    || path.resolve(response.outputDirectory) !== directory || path.resolve(response.resultFile) !== resultFile) throw new Error('Assembly tool returned an unexpected result location')
  u.assertUnchanged(input.fingerprint, u.fingerprint(path.dirname(input.files[0]), input.files))
  u.assertFile(resultFile)
  if (fs.statSync(resultFile).size > MAX_RESULT_BYTES) throw new Error('Assembly result exceeds its size limit')
  const resultBytes = fs.readFileSync(resultFile)
  const result = JSON.parse(resultBytes.toString('utf8'))
  if (result.schemaVersion !== 1 || result.toolkitManifestSha256 !== toolkit.files.find(file => file.path === 'toolkit-manifest.json')?.sha256) {
    throw new Error('Assembly result does not match the pinned toolkit manifest')
  }
  toolkitApi.validatePublicIdentity(result.publicIdentity)
  if (result.publicIdentity.id !== result.issuerKeyId
    || u.hash(runtime.canonicalJson(result.publicIdentity)) !== result.issuerFingerprint) {
    throw new Error('Assembly result signing identity does not match its fingerprint')
  }
  const installers = validateResult(result, toolkit, directory, source)
  const retained = retainedInputs(directory, source)
  const verified = invoke(toolkit, ['verify', '--toolkit', toolkit.directory, '--result', resultFile], invokeOptions)
  if (verified.verified !== true || verified.issuerKeyId !== result.issuerKeyId) throw new Error('Installer assembly verification failed')
  const checked = validateResult(verified, toolkit, directory, source)
  if (runtime.canonicalJson(checked) !== runtime.canonicalJson(installers)) throw new Error('Installer verification returned a different artifact inventory')
  if (verified.issuerFingerprint !== result.issuerFingerprint) {
    throw new Error('Installer verification returned a different signing identity')
  }
  if (!fs.readFileSync(resultFile).equals(resultBytes)) throw new Error('Assembly result changed during verification')
  assertConfigurationUnchanged(configuration, root)
  u.assertUnchanged(input.fingerprint, u.fingerprint(path.dirname(input.files[0]), input.files))
  return { installers, retainedInputs: retained, preparedToolkit: toolkit, result, resultFile, resultSha256: u.hash(resultBytes), toolkit: {
    toolkitVersion: toolkit.reference.toolkitVersion, interfaceVersion: toolkitApi.INTERFACE_VERSION,
    ...(toolkit.reference.archive.path ? { archivePath: toolkit.reference.archive.path } : { archiveUrl: toolkit.reference.archive.url }),
    archiveSize: toolkit.reference.archive.size,
    archiveSha256: toolkit.reference.archive.sha256, manifestSha256: result.toolkitManifestSha256,
    referenceSha256: toolkit.referenceSha256 || null, inputs: toolkit.inputs, authority: 'self-built' } }
}

function verifyCollected(assembled, directory, options = {}, collection = null) {
  const resultFile = path.join(directory, 'assembly-result.json')
  if (u.sha256(resultFile) !== assembled.resultSha256) throw new Error('Collected assembly result does not match its verified source')
  const snapshot = () => u.fingerprint(directory, u.listFiles(directory, new Set()))
  const before = snapshot()
  if (collection?.collectionFingerprint) u.assertUnchanged(collection.collectionFingerprint, before)
  const source = { edition: assembled.result.edition, productVersion: assembled.result.productVersion, inputs: assembled.result.inputs,
    ...(assembled.result.installationConfigurationSha256 !== undefined ? { installationConfigurationSha256: assembled.result.installationConfigurationSha256 } : {}) }
  const checked = invoke(assembled.preparedToolkit, ['verify', '--toolkit', assembled.preparedToolkit.directory, '--result', resultFile], options)
  validateResult(checked, assembled.preparedToolkit, directory, source)
  retainedInputs(directory, source)
  if (checked.verified !== true || checked.issuerKeyId !== assembled.result.issuerKeyId
    || checked.issuerFingerprint !== assembled.result.issuerFingerprint
    || runtime.canonicalJson(checked.artifacts) !== runtime.canonicalJson(assembled.result.artifacts)
    || u.sha256(resultFile) !== assembled.resultSha256) throw new Error('Collected installer verification does not match its original result')
  u.assertUnchanged(before, snapshot())
  return checked
}

module.exports = { invoke, inspectToolkit, preflight, inputIdentity, validateResult, retainedInputs, assemble, verifyCollected }
