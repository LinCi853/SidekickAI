'use strict'

const fs = require('node:fs')
const path = require('node:path')
const application = require('./application-packaging.cjs')
const assembly = require('./assemble-application.cjs')
const toolkitApi = require('./distribution-toolkit.cjs')
const utilities = require('./build-utils.cjs')
const { withPackagingLock } = require('./packaging-lock.cjs')
const { rootPackageVersion } = require('./sync-versions.cjs')
const ROOT = path.resolve(__dirname, '..')

function productIdentity(root = ROOT) {
  const product = JSON.parse(fs.readFileSync(path.join(root, 'packages/product-contract/manifest.json'), 'utf8'))
  const { edition } = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8'))
  if (!product.editions[edition]) throw new Error('Application product edition is missing')
  return { edition, version: rootPackageVersion(root) }
}

function parseArguments(args, identity = productIdentity()) {
  const options = { mode: 'all', architectures: ['x64', 'arm64'], preflightOnly: false, outputRoot: null }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--preflight') options.preflightOnly = true
    else if (args[index] === '--no-publish') continue
    else if (args[index] === '--mode' && ['portable', 'payload', 'all', 'installer', 'complete'].includes(args[index + 1])) options.mode = args[++index]
    else if (args[index] === '--output' && args[index + 1] && !args[index + 1].startsWith('--')) options.outputRoot = path.resolve(args[++index])
    else throw new Error('Usage: build-distribution.cjs [--mode portable|payload|all|installer|complete] [--preflight] [--output <directory>]')
  }
  modePackages(options.mode, identity.edition)
  return { ...options, edition: identity.edition, version: identity.version }
}

function modePackages(mode, edition) {
  const installer = ['installer', 'complete'].includes(mode)
  if (installer && edition !== 'concept') throw new Error('This public workspace supports concept offline installers only')
  return { installer, payload: mode !== 'portable', portable: ['portable', 'all', 'complete'].includes(mode) }
}

function captureInputs(root = ROOT) {
  const inputs = ['src', 'electron', 'scripts', 'packages', 'plugins', 'resources', 'tools/startup-helper',
    'package.json', 'package-lock.json', 'electron-builder.yml', 'electron-builder.portable.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json',
    'LICENSE', 'product-edition.json', 'maintenance/shared-source.json', 'maintenance/component-contract.json', 'maintenance/distribution-toolkit.json', 'maintenance/installation-configuration.json', 'build/License.txt']
  const excluded = new Set(['node_modules', 'target', 'dist', 'gen', '.git'])
  const files = []
  const collect = file => {
    if (!fs.existsSync(file)) return
    const relative = path.relative(root, file).replaceAll('\\', '/')
    if (/^resources\/(?:plugins(?:\/|$)|plugin-inventory\.json$)/.test(relative)) return
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error(`Linked distribution input: ${relative}`)
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) if (!excluded.has(entry.name)) collect(path.join(file, entry.name))
    } else if (stat.isFile()) files.push(file)
    else throw new Error(`Unsupported distribution input: ${relative}`)
  }
  for (const input of inputs) collect(path.join(root, input))
  return utilities.fingerprint(root, files)
}

const defaults = {
  captureInputs,
  prepareResources: application.prepareNativeResources,
  preflight: application.preflight,
  buildPlugins: options => fs.existsSync(path.join(ROOT, 'scripts/build-plugins.cjs')) ? require('./build-plugins.cjs').main(options) : [],
  buildApplications: (output, architectures) => application.buildApplications(output, architectures, { reuse: true }),
  buildPayloads: options => require('./application-payload.cjs').packApplicationPayloads(options),
  buildPortable: options => require('./pack-portable.cjs').packPortable(options),
  preflightToolkit: () => assembly.preflight({ root: ROOT }),
  assertToolkit: toolkitApi.assertUnchanged,
  buildInstallers: options => assembly.assemble({ root: ROOT, ...options }),
}

async function buildCandidates(options, output, dependencies = defaults) {
  parseArguments(['--mode', options.mode], options)
  if (options.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => options.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  const packages = modePackages(options.mode, options.edition)
  const toolkit = packages.installer ? await dependencies.preflightToolkit() : null
  if (!options.preflightOnly) await dependencies.prepareResources?.()
  const before = dependencies.captureInputs()
  const guard = () => {
    utilities.assertUnchanged(before, dependencies.captureInputs())
    if (toolkit) dependencies.assertToolkit(toolkit)
  }
  await dependencies.preflight(options.architectures, path.join(output, 'preflight'))
  guard()
  if (options.preflightOnly) return { preflight: true, ...options, inputs: before }
  const plugins = await dependencies.buildPlugins({ distRoot: path.join(output, 'plugins'), shipBundledResources: false })
  guard()
  const applications = await dependencies.buildApplications(path.join(output, 'application'), options.architectures)
  guard()
  const artifacts = { ...options, applications, plugins, inputs: before }
  if (packages.payload) {
    artifacts.payloads = await dependencies.buildPayloads({ output: path.join(output, 'payload'), applications, architectures: options.architectures })
    guard()
  }
  if (packages.portable) {
    artifacts.portable = await dependencies.buildPortable({ output: path.join(output, 'portable'), applications, architectures: options.architectures })
    guard()
  }
  if (packages.installer) {
    artifacts.assembly = await dependencies.buildInstallers({ output: path.join(output, 'assembly'), payloads: artifacts.payloads,
      edition: options.edition, productVersion: options.version, toolkit })
    guard()
  }
  return artifacts
}

function collectCandidates(artifacts, output, root = ROOT) {
  const identity = productIdentity(root)
  if (artifacts.edition !== identity.edition || artifacts.version !== identity.version) throw new Error('Candidate identity does not match the current product configuration')
  parseArguments(['--mode', artifacts.mode], identity)
  const packages = modePackages(artifacts.mode, artifacts.edition)
  if (artifacts.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => artifacts.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  const directory = path.join(output, artifacts.edition)
  fs.mkdirSync(directory)
  const files = []
  const add = (source, name, role, architecture, expectedSha256) => {
    if (!source) throw new Error('Invalid candidate artifact')
    require('./application-runtime.cjs').validateRelativePath(name)
    if (files.some(file => file.file.toLowerCase() === name.toLowerCase())) throw new Error('Duplicate candidate artifact')
    utilities.assertFile(source)
    const target = path.join(directory, ...name.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    const sha256 = utilities.sha256(target)
    if (sha256 !== utilities.sha256(source) || expectedSha256 && sha256 !== expectedSha256) throw new Error('Candidate changed during copy')
    files.push({ edition: artifacts.edition, version: artifacts.version, platform: 'windows', architecture,
      packageKind: role, role, file: name, size: fs.statSync(target).size, sha256,
      contentType: name.endsWith('.json') ? 'application/json' : name.endsWith('.exe') ? 'application/vnd.microsoft.portable-executable' : 'application/zip' })
  }
  if (packages.payload) {
    if (artifacts.payloads?.length !== 2 || !['x64', 'arm64'].every(arch => artifacts.payloads.filter(payload => payload.architecture === arch).length === 1)) throw new Error('Distribution requires two standard application payloads')
    for (const arch of ['x64', 'arm64']) {
      const payload = artifacts.payloads.find(entry => entry.architecture === arch)
      const manifestBytes = fs.readFileSync(payload.manifestPath)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      require('./application-payload.cjs').validateManifest(manifest)
      if (manifest.edition !== artifacts.edition || manifest.productVersion !== artifacts.version || manifest.architecture !== arch
        || manifest.archive.sha256 !== utilities.sha256(payload.path) || manifest.archive.size !== fs.statSync(payload.path).size
        || manifest.archive.file !== path.basename(payload.path)) throw new Error('Application payload manifest does not match its candidate')
      if (packages.installer && (artifacts.assembly?.result?.inputs?.[arch]?.manifestSha256 !== utilities.hash(manifestBytes)
        || artifacts.assembly.result.inputs[arch].archiveSha256 !== manifest.archive.sha256)) {
        throw new Error('Application payload changed after installer assembly')
      }
      add(payload.path, manifest.archive.file, 'application-payload', arch, manifest.archive.sha256)
      add(payload.manifestPath, manifest.archive.file.replace(/\.zip$/, '.manifest.json'), 'application-payload-manifest', arch, utilities.hash(manifestBytes))
    }
  } else if (artifacts.payloads) throw new Error('Unexpected application payload candidates')
  if (packages.portable) {
    if (artifacts.portable?.length !== 1 || artifacts.portable[0].arch !== 'universal') throw new Error('Portable delivery must be one dual-architecture archive')
    add(artifacts.portable[0].path, 'SidekickAI-Portable-' + artifacts.version + '-win.zip', 'portable', 'universal', artifacts.portable[0].sha256)
  } else if (artifacts.portable) throw new Error('Unexpected portable candidate')
  let assemblyEvidence
  if (packages.installer) {
    const assembled = artifacts.assembly
    if (!assembled?.result || !assembled.toolkit || !assembled.resultFile || !assembled.resultSha256
      || assembled.installers?.length !== 2 || assembled.result.authority !== 'self-built'
      || assembled.result.edition !== artifacts.edition || assembled.result.productVersion !== artifacts.version) {
      throw new Error('Distribution requires verified self-built installer candidates')
    }
    if (utilities.sha256(assembled.resultFile) !== assembled.resultSha256) throw new Error('Assembly result changed before candidate collection')
    for (const arch of ['x64', 'arm64']) {
      const matches = assembled.installers.filter(file => file.architecture === arch)
      if (matches.length !== 1) throw new Error('Distribution requires one offline installer per architecture')
      const file = matches[0]
      const entry = assembled.result.artifacts?.find(item => item.architecture === arch && item.role === 'offline-installer')
      if (!entry) throw new Error('Assembly result is missing an installer artifact')
      add(file.path, entry.path, 'offline-installer', arch, file.sha256)
    }
    const configurationSha256 = assembled.result.installationConfigurationSha256
    if (assembled.retainedInputs?.length !== (configurationSha256 === undefined ? 4 : 5)) throw new Error('Installer candidates require their immutable verification inputs')
    for (const file of assembled.retainedInputs) add(file.file, file.path, 'assembly-input', file.architecture, file.sha256)
    add(assembled.resultFile, 'assembly-result.json', 'installer-assembly-result', null, assembled.resultSha256)
    assemblyEvidence = { authority: 'self-built', issuerKeyId: assembled.result.issuerKeyId,
      issuerFingerprint: assembled.result.issuerFingerprint, inputs: assembled.result.inputs,
      resultSha256: assembled.resultSha256, toolkit: assembled.toolkit,
      ...(configurationSha256 === undefined ? {} : { installationConfigurationSha256: configurationSha256 }) }
  } else if (artifacts.assembly) throw new Error('Unexpected installer assembly candidates')
  const shared = JSON.parse(fs.readFileSync(path.join(root, 'maintenance/shared-source.json'), 'utf8'))
  const manifest = { schemaVersion: 1, status: 'candidate', softwareId: 'sidekickai', edition: artifacts.edition, version: artifacts.version,
    generatedAt: new Date().toISOString(), architectures: artifacts.architectures,
    sourceInputs: artifacts.inputs, sharedSource: shared, artifacts: files, architectureEvidence: [],
    ...(assemblyEvidence ? { assembly: assemblyEvidence } : {}) }
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
  const checksumBytes = files.map(file => file.sha256 + '  ' + file.file).join('\n') + '\n'
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), manifestBytes, { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), checksumBytes, { flag: 'wx' })
  const collectionFiles = utilities.listFiles(directory, new Set())
  const collectionFingerprint = utilities.fingerprint(directory, collectionFiles)
  const expected = new Map([...files.map(file => [file.file, file.sha256]),
    ['release-manifest.json', utilities.hash(manifestBytes)], ['SHA256SUMS.txt', utilities.hash(checksumBytes)]])
  if (collectionFingerprint.entries.length !== expected.size
    || collectionFingerprint.entries.some(file => expected.get(file.path) !== file.sha256)) throw new Error('Collected candidate bytes do not match their verified inventory')
  return { directory, files, manifest, collectionFingerprint }
}

async function main(args = process.argv.slice(2)) {
  Object.assign(process.env, require('./local-build-config.cjs').localBuildEnvironment(ROOT))
  require('./check-node-version.cjs').assertNodeVersion()
  const options = parseArguments(args)
  require('../packages/product-contract/sync.cjs').synchronize(ROOT)
  require('./shared-source.cjs').check(ROOT)
  return withPackagingLock(async () => {
    const output = utilities.uniqueOutput(options.outputRoot || path.join(ROOT, 'build/distribution-runs', options.edition))
    try {
      const artifacts = await buildCandidates(options, output)
      if (artifacts.preflight) return { output, artifacts }
      utilities.assertUnchanged(artifacts.inputs, captureInputs())
      const result = collectCandidates(artifacts, output)
      if (artifacts.assembly) assembly.verifyCollected(artifacts.assembly, result.directory, {}, result)
      utilities.assertUnchanged(artifacts.inputs, captureInputs())
      console.log(`[distribution] Verified local candidates: ${result.directory}`)
      return { output, ...result }
    } catch (error) {
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ edition: options.edition, mode: options.mode, error: error.message }, null, 2) + '\n')
      throw error
    }
  })
}

module.exports = { productIdentity, parseArguments, modePackages, captureInputs, buildCandidates, collectCandidates, main }
if (require.main === module) main().catch(error => { console.error(`[distribution] ${error.stack || error}`); process.exitCode = 1 })
