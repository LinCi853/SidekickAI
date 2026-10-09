'use strict'

const fs = require('node:fs')
const path = require('node:path')
const application = require('./application-packaging.cjs')
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
    else if (args[index] === '--mode' && ['portable', 'payload', 'all'].includes(args[index + 1])) options.mode = args[++index]
    else if (args[index] === '--output' && args[index + 1] && !args[index + 1].startsWith('--')) options.outputRoot = path.resolve(args[++index])
    else throw new Error('Usage: build-distribution.cjs [--mode portable|payload|all] [--preflight] [--output <directory>]')
  }
  return { ...options, edition: identity.edition, version: identity.version }
}

function captureInputs(root = ROOT) {
  const inputs = ['src', 'electron', 'scripts', 'packages', 'plugins', 'resources', 'tools/startup-helper',
    'package.json', 'package-lock.json', 'electron-builder.yml', 'electron-builder.portable.yml', 'electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json',
    'LICENSE', 'product-edition.json', 'maintenance/shared-source.json', 'maintenance/component-contract.json', 'build/License.txt']
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
}

async function buildCandidates(options, output, dependencies = defaults) {
  parseArguments(['--mode', options.mode], options)
  if (options.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => options.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  if (!options.preflightOnly) await dependencies.prepareResources?.()
  const before = dependencies.captureInputs()
  const guard = () => utilities.assertUnchanged(before, dependencies.captureInputs())
  await dependencies.preflight(options.architectures, path.join(output, 'preflight'))
  guard()
  if (options.preflightOnly) return { preflight: true, ...options, inputs: before }
  const plugins = await dependencies.buildPlugins({ distRoot: path.join(output, 'plugins'), shipBundledResources: false })
  guard()
  const applications = await dependencies.buildApplications(path.join(output, 'application'), options.architectures)
  guard()
  const artifacts = { ...options, applications, plugins, inputs: before }
  if (options.mode !== 'portable') {
    artifacts.payloads = await dependencies.buildPayloads({ output: path.join(output, 'payload'), applications, architectures: options.architectures })
    guard()
  }
  if (options.mode !== 'payload') {
    artifacts.portable = await dependencies.buildPortable({ output: path.join(output, 'portable'), applications, architectures: options.architectures })
    guard()
  }
  return artifacts
}

function collectCandidates(artifacts, output, root = ROOT) {
  const identity = productIdentity(root)
  if (artifacts.edition !== identity.edition || artifacts.version !== identity.version) throw new Error('Candidate identity does not match the current product configuration')
  parseArguments(['--mode', artifacts.mode], identity)
  if (artifacts.architectures?.length !== 2 || !['x64', 'arm64'].every(arch => artifacts.architectures.includes(arch))) throw new Error('Distribution requires both x64 and arm64')
  const directory = path.join(output, artifacts.edition)
  fs.mkdirSync(directory)
  const files = []
  const add = (source, name, role, architecture, expectedSha256) => {
    if (!source || path.basename(name) !== name) throw new Error('Invalid candidate artifact')
    utilities.assertFile(source)
    const target = path.join(directory, name)
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    const sha256 = utilities.sha256(target)
    if (sha256 !== utilities.sha256(source) || expectedSha256 && sha256 !== expectedSha256) throw new Error('Candidate changed during copy')
    files.push({ edition: artifacts.edition, version: artifacts.version, platform: 'windows', architecture,
      packageKind: role, role, file: name, size: fs.statSync(target).size, sha256,
      contentType: role === 'application-payload-manifest' ? 'application/json' : 'application/zip' })
  }
  if (artifacts.mode !== 'portable') {
    if (artifacts.payloads?.length !== 2 || !['x64', 'arm64'].every(arch => artifacts.payloads.filter(payload => payload.architecture === arch).length === 1)) throw new Error('Distribution requires two standard application payloads')
    for (const arch of ['x64', 'arm64']) {
      const payload = artifacts.payloads.find(entry => entry.architecture === arch)
      const manifestBytes = fs.readFileSync(payload.manifestPath)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      require('./application-payload.cjs').validateManifest(manifest)
      if (manifest.edition !== artifacts.edition || manifest.productVersion !== artifacts.version || manifest.architecture !== arch
        || manifest.archive.sha256 !== utilities.sha256(payload.path) || manifest.archive.size !== fs.statSync(payload.path).size
        || manifest.archive.file !== path.basename(payload.path)) throw new Error('Application payload manifest does not match its candidate')
      add(payload.path, manifest.archive.file, 'application-payload', arch, manifest.archive.sha256)
      add(payload.manifestPath, manifest.archive.file.replace(/\.zip$/, '.manifest.json'), 'application-payload-manifest', arch, utilities.hash(manifestBytes))
    }
  } else if (artifacts.payloads) throw new Error('Unexpected application payload candidates')
  if (artifacts.mode !== 'payload') {
    if (artifacts.portable?.length !== 1 || artifacts.portable[0].arch !== 'universal') throw new Error('Portable delivery must be one dual-architecture archive')
    add(artifacts.portable[0].path, 'SidekickAI-Portable-' + artifacts.version + '-win.zip', 'portable', 'universal', artifacts.portable[0].sha256)
  } else if (artifacts.portable) throw new Error('Unexpected portable candidate')
  const shared = JSON.parse(fs.readFileSync(path.join(root, 'maintenance/shared-source.json'), 'utf8'))
  const manifest = { schemaVersion: 1, status: 'candidate', softwareId: 'sidekickai', edition: artifacts.edition, version: artifacts.version,
    generatedAt: new Date().toISOString(), architectures: artifacts.architectures,
    sourceInputs: artifacts.inputs, sharedSource: shared, artifacts: files, architectureEvidence: [] }
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), files.map(file => file.sha256 + '  ' + file.file).join('\n') + '\n', { flag: 'wx' })
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
