'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const native = require('./build-tauri-installer.cjs')
const utilities = require('./uninstaller-build-utils.cjs')
const { withPackagingLock } = require('./packaging-lock.cjs')
const { rootPackageVersion } = require('./sync-versions.cjs')
const ROOT = path.resolve(__dirname, '..')

function productIdentity(root = ROOT) {
  const product = JSON.parse(fs.readFileSync(path.join(root, 'packages/product-contract/manifest.json'), 'utf8'))
  const { edition } = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8'))
  if (!product.editions[edition]?.packageKinds?.length) throw new Error('Distribution package policy is missing')
  return { edition, version: rootPackageVersion(root), packageKinds: product.editions[edition].packageKinds,
    distribution: product.editions[edition].distribution }
}

function parseArguments(args, identity = productIdentity()) {
  const options = { mode: identity.edition === 'concept' ? 'all' : 'installer',
    architectures: ['x64', 'arm64'], preflightOnly: false, outputRoot: null }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--preflight') options.preflightOnly = true
    else if (args[index] === '--no-publish') continue
    else if (args[index] === '--mode' && ['installer', 'portable', 'all'].includes(args[index + 1])) options.mode = args[++index]
    else if (args[index] === '--output' && args[index + 1]) options.outputRoot = path.resolve(args[++index])
    else throw new Error('Usage: build-distribution.cjs [--mode installer|portable|all] [--preflight] [--output <directory>]')
  }
  const kinds = options.mode === 'all' ? ['installer', 'portable'] : [options.mode]
  if (kinds.some(kind => !identity.packageKinds.includes(kind))) throw new Error(`${identity.edition} does not distribute ${options.mode}; use an allowed package kind`)
  return { ...options, ...identity }
}

function captureInputs(root = ROOT) {
  const inputs = ['src', 'electron', 'scripts', 'packages', 'plugins', 'resources', 'tools/startup-helper', 'tools/backup-recovery-native', 'installer-tauri', 'uninstaller-tauri', 'installer-shared',
    'package.json', 'package-lock.json', 'electron-builder.yml', 'electron-builder.portable.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json',
    'LICENSE', 'product-edition.json', 'maintenance/shared-source.json', 'maintenance/component-contract.json', 'build/License.txt',
    '.cargo/config.toml', '.cargo/config', 'rust-toolchain.toml', 'rust-toolchain']
  const excluded = new Set(['node_modules', 'target', 'dist', 'gen', '.git'])
  const files = []
  const collect = file => {
    if (!fs.existsSync(file)) return
    const relative = path.relative(root, file).replaceAll('\\', '/')
    if (/^resources\/(?:plugins(?:\/|$)|plugin-inventory\.json$)/.test(relative)
      || /^installer-tauri\/src-tauri\/(?:install-manifest\.json|build(?:-offline)?\.log)$/.test(relative)) return
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
  prepareResources: native.prepareNativeResources,
  preflight: (architectures, output) => native.preflight(architectures, true, output),
  buildPlugins: options => fs.existsSync(path.join(ROOT, 'scripts/build-plugins.cjs')) ? require('./build-plugins.cjs').main(options) : [],
  buildApplications: (output, architectures) => native.buildApplications(output, architectures, { reuse: true }),
  buildRecoveryEntries: (output, architectures, toolchain) => native.buildRecoveryEntries(output, architectures, toolchain),
  buildInstallers: (output, applications, architectures, toolchain, recoveryEntries) => native.buildInstallerArtifacts(output, applications, architectures, toolchain, { reuse: true, recoveryEntries }),
  buildPortable: options => require('./pack-portable.cjs').packPortable(options),
}

async function buildCandidates(options, output, dependencies = defaults) {
  parseArguments(['--mode', options.mode], options)
  if (options.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => options.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  if (!options.preflightOnly) await dependencies.prepareResources?.()
  const before = dependencies.captureInputs()
  const guard = () => utilities.assertUnchanged(before, dependencies.captureInputs())
  const toolchain = await dependencies.preflight(options.architectures, path.join(output, 'preflight'), options.mode)
  guard()
  if (options.preflightOnly) return { preflight: true, ...options, inputs: before }
  const plugins = await dependencies.buildPlugins({ distRoot: path.join(output, 'plugins'), shipBundledResources: false })
  guard()
  const applications = await dependencies.buildApplications(path.join(output, 'application'), options.architectures)
  guard()
  const artifacts = { ...options, applications, plugins, inputs: before }
  const recoveryEntries = await dependencies.buildRecoveryEntries?.(path.join(output, 'maintenance'), options.architectures, toolchain)
  guard()
  if (options.mode !== 'portable') {
    artifacts.installers = await dependencies.buildInstallers(path.join(output, 'installation'), applications, options.architectures, toolchain, recoveryEntries)
    guard()
  }
  if (options.mode !== 'installer') {
    artifacts.portable = await dependencies.buildPortable({ output: path.join(output, 'portable'), applications,
      architectures: options.architectures, recoveryEntries })
    guard()
  }
  return artifacts
}

function collectCandidates(artifacts, output, root = ROOT) {
  const identity = productIdentity(root)
  if (artifacts.edition !== identity.edition || artifacts.version !== identity.version) throw new Error('Candidate identity does not match the current product configuration')
  parseArguments(['--mode', artifacts.mode], identity)
  if (artifacts.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => artifacts.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  const channel = require('./application-distribution.cjs').releaseChannel(artifacts.version)
  const directory = path.join(output, artifacts.edition)
  fs.mkdirSync(directory)
  const files = []
  const add = (source, name, role, supportedNativeArchitectures, executableArchitecture, bodyProofSha256 = null) => {
    if (!source || path.basename(name) !== name) throw new Error('Invalid candidate artifact')
    const target = path.join(directory, name)
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    const sha256 = utilities.sha256(target)
    if (sha256 !== utilities.sha256(source)) throw new Error('Candidate changed during copy')
    if (executableArchitecture && utilities.peInfo(fs.readFileSync(target)).arch !== executableArchitecture) {
      throw new Error('Candidate PE architecture does not match its distribution role')
    }
    files.push({ edition: artifacts.edition, version: artifacts.version, platform: 'windows',
      architecture: executableArchitecture || (supportedNativeArchitectures.length === 2 ? 'universal' : supportedNativeArchitectures[0]),
      packageKind: role === 'portable' ? 'portable' : role === 'application-payload' ? 'application-payload' : 'installer',
      role, executableArchitecture, supportedNativeArchitectures, bodyProofSha256,
      visibility: role === 'application-payload' ? 'internal' : 'public', assetId: sha256,
      file: name, sizeBytes: fs.statSync(target).size, sha256,
      contentType: executableArchitecture ? 'application/vnd.microsoft.portable-executable' : 'application/zip' })
  }
  if (artifacts.installers) {
    if (artifacts.edition === 'community') {
      add(artifacts.installers.setups?.x64, 'SidekickAI-Setup-' + artifacts.version + '.exe',
        'online-bootstrap', ['x64', 'arm64'], 'x64')
      for (const arch of ['x64', 'arm64']) {
        const payload = artifacts.installers.payloads?.[arch]
        add(payload?.container?.path, 'SidekickAI-Application-' + artifacts.version + '-' + arch + '.zip',
          'application-payload', [arch], null, payload?.bodyProofSha256)
      }
    } else {
      for (const arch of ['x64', 'arm64']) add(artifacts.installers.setups?.[arch],
        'SidekickAI-Setup-' + artifacts.version + '-' + arch + '.exe',
        'offline-installer', [arch], arch, artifacts.installers.payloads?.[arch]?.bodyProofSha256)
    }
  }
  if (artifacts.portable) {
    if (artifacts.portable.length !== 1 || artifacts.portable[0].arch !== 'universal') throw new Error('Portable delivery must be one dual-architecture archive')
    const portable = artifacts.portable[0]
    add(portable.path, 'SidekickAI-Portable-' + artifacts.version + '-win.zip',
      'portable', ['x64', 'arm64'], null, portable.bodyProofSha256)
  }
  const expected = artifacts.edition === 'community' ? ['online-bootstrap', 'application-payload', 'application-payload']
    : artifacts.mode === 'all' ? ['offline-installer', 'offline-installer', 'portable']
      : artifacts.mode === 'installer' ? ['offline-installer', 'offline-installer'] : ['portable']
  if (files.length !== expected.length || files.some((file, index) => file.role !== expected[index])
    || files.some(file => file.role !== 'online-bootstrap' && !/^[a-f0-9]{64}$/.test(file.bodyProofSha256 || ''))) {
    throw new Error('Distribution artifacts do not match the approved package matrix')
  }
  const shared = JSON.parse(fs.readFileSync(path.join(root, 'maintenance/shared-source.json'), 'utf8'))
  const manifest = { schemaVersion: 1, distributionProtocolVersion: 1, status: 'candidate',
    softwareId: 'sidekickai', edition: artifacts.edition, version: artifacts.version, channel,
    generatedAt: new Date().toISOString(), architectures: artifacts.architectures,
    sourceInputs: artifacts.inputs, sharedSource: shared, artifacts: files, architectureEvidence: [] }
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), files.map(file => file.sha256 + '  ' + file.file).join('\n') + '\n', { flag: 'wx' })
  if (files.length === 3) {
    const release = { protocolVersion: 1, productId: 'sidekickai', edition: artifacts.edition,
      productVersion: artifacts.version, releaseId: crypto.randomUUID(), channel, platform: 'windows',
      maintenanceProtocolVersion: 1, recoveryProtocolVersion: 1,
      assets: files.map(file => ({ assetId: file.assetId, role: file.role, filename: file.file, sizeBytes: file.sizeBytes,
        sha256: file.sha256, contentType: file.contentType, executableArchitecture: file.executableArchitecture,
        supportedNativeArchitectures: file.supportedNativeArchitectures, bodyProofSha256: file.bodyProofSha256 })),
      publicAssetIds: files.filter(file => file.visibility === 'public').map(file => file.assetId),
      architectureEvidence: [], notes: '', createdAt: manifest.generatedAt }
    fs.writeFileSync(path.join(directory, 'application-release-candidate.json'), JSON.stringify(release, null, 2) + '\n', { flag: 'wx' })
  }
  return { directory, files, manifest }
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
      utilities.assertUnchanged(artifacts.inputs, captureInputs())
      console.log(`[distribution] Verified local candidates: ${result.directory}`)
      return { output, ...result }
    } catch (error) {
      fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ edition: options.edition, mode: options.mode, error: error.message }, null, 2) + '\n')
      throw error
    }
  })
}

module.exports = { productIdentity, parseArguments, captureInputs, buildCandidates, collectCandidates, main }
if (require.main === module) main().catch(error => { console.error(`[distribution] ${error.stack || error}`); process.exitCode = 1 })
