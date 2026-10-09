'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const u = require('./build-utils.cjs')
const cache = require('./build-cache.cjs')
const runtime = require('./application-runtime.cjs')
const buildEvidence = require('./build-evidence.cjs')
const ROOT = path.resolve(__dirname, '..')
const EDITION = require('../product-edition.json').edition
const VERSION = require('../package.json').version
const TARGETS = { x64: { directory: 'win-unpacked' }, arm64: { directory: 'win-arm64-unpacked' } }
const REQUIRED_RUNTIME_FILES = [
  'SidekickAI.exe', 'resources/app.asar', 'resources/LICENSE.application.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
  'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
  'locales/en-US.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak',
]

function run(command, args, label, options = {}) {
  const started = Date.now()
  console.log(`\n[build] ${label}\n${JSON.stringify([command, ...args])}`)
  let output
  if (options.output) output = fs.openSync(options.output, 'w')
  let result
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd || ROOT,
      windowsHide: true,
      stdio: output === undefined ? 'inherit' : ['ignore', output, 'inherit'],
      env: { ...process.env, ...(options.env || {}) },
    })
  } finally { if (output !== undefined) fs.closeSync(output) }
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: exit ${result.status}, signal ${result.signal || 'none'}`)
  console.log(`[timing] ${label}: ${Date.now() - started} ms`)
}

function validateArchitectures(architectures) {
  if (!Array.isArray(architectures) || !architectures.length || architectures.some(arch => !Object.hasOwn(TARGETS, arch)) || new Set(architectures).size !== architectures.length) {
    throw new Error('Expected a nonempty list of unique Windows architectures: x64, arm64')
  }
  return architectures
}

function applicationPackageInputs() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const packages = Object.entries(lock.packages || {})
    .filter(([name, entry]) => name.startsWith('node_modules/') && !entry.dev && fs.existsSync(path.join(ROOT, name)))
    .map(([name]) => path.join(ROOT, name))
  return ['out', 'resources', 'packages/product-contract', 'packages/desktop-common', 'packages/backup-core', 'product-edition.json', 'electron-builder.yml', 'package.json', 'package-lock.json',
    'scripts/verify-packaged-ui.cjs', 'scripts/check-node-version.cjs', 'scripts/verify-packaged-native.cjs',
    'scripts/build-startup-helper.cjs', 'scripts/prepare-startup-helper.cjs', 'scripts/verify-startup-helper.cjs', 'tools/startup-helper', 'build/License.txt', 'LICENSE',
    'node_modules/electron/package.json', 'node_modules/electron-builder', 'node_modules/app-builder-lib']
    .map(file => path.join(ROOT, file)).filter(file => fs.existsSync(file)).concat(packages, process.env.SIDEKICK_ELECTRON_DIST ? [path.resolve(process.env.SIDEKICK_ELECTRON_DIST)] : [], [__filename])
    .concat(['scripts/application-runtime.cjs', 'scripts/build-utils.cjs', 'scripts/oxy-build-config.cjs', 'scripts/local-build-config.cjs'].map(file => path.join(ROOT, file)))
    .flatMap(file => fs.statSync(file).isDirectory() ? u.listFiles(file, new Set(['.git'])) : [file])
}

function buildApplications(output, architectures, options = {}) {
  require('./check-node-version.cjs').assertNodeVersion()
  validateArchitectures(architectures)
  prepareNativeResources()
  const appOutput = path.join(output, 'application-build')
  if (fs.existsSync(appOutput)) throw new Error(`Application build directory already exists: ${appOutput}`)
  fs.mkdirSync(appOutput, { recursive: true })
  const inputs = ['electron', 'src', 'resources', 'packages/product-contract', 'packages/desktop-common', 'packages/backup-core', 'product-edition.json', 'package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.ts', 'scripts/compilation-inputs.ts', 'scripts/verify-packaged-ui.cjs', 'scripts/check-node-version.cjs', 'scripts/verify-packaged-native.cjs', 'build/License.txt', 'LICENSE'].map(file => path.join(ROOT, file)).filter(file => fs.existsSync(file))
  const before = u.fingerprint(ROOT, inputs)
  const compilation = require('./application-build.cjs').compile(output, run)
  const packageInputs = applicationPackageInputs()
  const packageBefore = u.fingerprint(ROOT, packageInputs)
  const signing = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CSC_|WIN_CSC_|SIGN_|ELECTRON_)/.test(key)))
  const evidence = {}
  const publicConfiguration = runtime.applicationConfiguration(ROOT)
  for (const arch of architectures) {
    const started = Date.now()
    const key = u.hash(JSON.stringify({ inputs: packageBefore.fingerprint, arch, node: process.version, signing, publicConfiguration }))
    const dir = path.join(appOutput, TARGETS[arch].directory)
    const decision = options.reuse ? cache.inspect(`application-${arch}`, key) : { value: null, reason: 'disabled' }
    const reused = decision.value
    if (reused) {
      const cachedInputs = applicationFingerprint(reused.directory)
      fs.cpSync(reused.directory, dir, { recursive: true, errorOnExist: true, force: false })
      u.assertUnchanged(cachedInputs, applicationFingerprint(reused.directory))
      u.assertUnchanged(cachedInputs, applicationFingerprint(dir))
      evidence[arch] = verifyApplication(dir, arch)
      buildEvidence.record(output, `application-${arch}`, key, decision, started, { directory: dir })
      console.log(`[build] Reused verified ${arch} application package`)
      continue
    }
    const packagingConfiguration = require('js-yaml').load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'))
    const otherArchitecture = arch === 'x64' ? 'arm64' : 'x64'
    packagingConfiguration.files = [...packagingConfiguration.files,
      '!node_modules/better-sqlite3/prebuilds/win32-' + otherArchitecture + '.node',
      '!node_modules/uiohook-napi/prebuilds/win32-' + otherArchitecture + '/**',
      '!node_modules/better-sqlite3/deps/**']
    packagingConfiguration.directories = { ...packagingConfiguration.directories, output: appOutput }
    const packagingFile = path.join(output, 'electron-builder-' + arch + '.json')
    fs.writeFileSync(packagingFile, JSON.stringify(packagingConfiguration, null, 2) + '\n', { flag: 'wx' })
    const args = [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--dir', '--' + arch, '--config', packagingFile]
    if (process.env.SIDEKICK_ELECTRON_DIST) args.push(`--config.electronDist=${path.resolve(process.env.SIDEKICK_ELECTRON_DIST)}`)
    run(process.execPath, args, `Current ${arch} application directory`)
    runtime.writeApplicationConfiguration(dir, publicConfiguration)
    evidence[arch] = verifyApplication(dir, arch)
    u.assertUnchanged(packageBefore, u.fingerprint(ROOT, packageInputs))
    const retained = cache.retainDirectory(`application-${arch}`, key, dir)
    cache.remember(`application-${arch}`, key, [retained], { directory: retained })
    buildEvidence.record(output, `application-${arch}`, key, decision, started, { directory: dir })
  }
  u.assertUnchanged(packageBefore, u.fingerprint(ROOT, packageInputs))
  u.assertUnchanged(before, u.fingerprint(ROOT, inputs))
  if (architectures.includes('x64')) {
    const reportDirectory = path.join(output, 'packaged-ui')
    run(process.execPath, [path.join(ROOT, 'scripts/verify-packaged-ui.cjs'), path.join(appOutput, TARGETS.x64.directory), reportDirectory], 'Packaged main window and settings acceptance')
    evidence.x64.uiReport = path.join(reportDirectory, 'report.json')
    u.assertUnchanged(before, u.fingerprint(ROOT, inputs))
  }
  fs.writeFileSync(path.join(output, 'application-inputs.json'), JSON.stringify(before, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'application-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'compilation-evidence.json'), JSON.stringify(compilation, null, 2) + '\n')
  u.assertUnchanged(compilation.dependencies, u.fingerprint(ROOT, require('./application-build.cjs').dependencyInputs(path.join(ROOT, 'out'), ROOT)))
  u.assertUnchanged(compilation.sourceInputs, u.fingerprint(ROOT, require('./application-build.cjs').inputs(ROOT)))
  return appOutput
}

function verifyRuntime(directory, arch, { edition = EDITION, productVersion = VERSION, allowPortable = false } = {}) {
  validateArchitectures([arch])
  for (const file of REQUIRED_RUNTIME_FILES) u.assertFile(path.join(directory, file))
  if (!allowPortable && fs.existsSync(path.join(directory, 'portable.txt'))) throw new Error(`Shared application directory already enables portable mode: ${directory}`)
  for (const entry of applicationFingerprint(directory).entries) runtime.validateSoftwarePath(entry.path)
  for (const name of require('@electron/asar').listPackage(path.join(directory, 'resources/app.asar'))) runtime.validateSoftwarePath(name.replaceAll('\\', '/').replace(/^\/+/, ''))
  const packaged = JSON.parse(require('@electron/asar').extractFile(path.join(directory, 'resources/app.asar'), 'package.json').toString())
  const product = require('../packages/product-contract/manifest.json')
  if (!product.editions[edition] || packaged.name !== product.editions[edition].packageName || packaged.version !== productVersion) throw new Error('Application payload edition/version mismatch')
  const native = require('./verify-packaged-native.cjs').verifyPackagedNative(directory, arch)
  return { directory, arch, native, inputs: applicationFingerprint(directory) }
}

function verifyApplication(directory, arch) {
  const verified = verifyRuntime(directory, arch)
  const nativeFiles = verifyNativeFiles(directory, arch)
  const startup = require('./build-startup-helper.cjs').verifyResources(path.join(directory, 'resources/windows'), { root: ROOT })
  const expectedConfiguration = runtime.applicationConfiguration(ROOT)
  const keys = JSON.parse(fs.readFileSync(path.join(directory, 'resources/application-trust.json'), 'utf8'))
  const resourceKeys = JSON.parse(fs.readFileSync(path.join(directory, 'resources/resource-trust.json'), 'utf8'))
  const service = JSON.parse(fs.readFileSync(path.join(directory, 'resources/oxy-service.json'), 'utf8'))
  if (runtime.canonicalJson(keys) !== runtime.canonicalJson(expectedConfiguration.keys)
    || runtime.canonicalJson(resourceKeys) !== runtime.canonicalJson(expectedConfiguration.resourceKeys)
    || service.origin !== expectedConfiguration.origin || Object.keys(service).length !== 1) throw new Error('Application public distribution configuration does not match build inputs')
  return { ...verified, nativeFiles, startup }
}

function verifyNativeFiles(directory, arch) {
  validateArchitectures([arch])
  return u.listFiles(directory, new Set()).filter(file => /\.(?:exe|dll|node)$/i.test(file)).map(file => {
    const bytes = fs.readFileSync(file)
    let architecture
    try { architecture = u.peInfo(bytes).arch } catch {
      require('./build-startup-helper.cjs').verifyManagedArchitecture(bytes)
      architecture = 'anycpu'
    }
    if (architecture !== arch && architecture !== 'anycpu') throw new Error(`Application native architecture mismatch: ${path.relative(directory, file)}`)
    return { path: path.relative(directory, file).replaceAll('\\', '/'), architecture }
  })
}

function applicationFingerprint(directory) {
  return u.fingerprint(directory, u.listFiles(directory, new Set()))
}

function prepareNativeResources() {
  return { startup: require('./build-startup-helper.cjs').build({ resources: true }) }
}

function preflight(architectures, output) {
  require('./check-node-version.cjs').assertNodeVersion()
  validateArchitectures(architectures)
  if (process.platform !== 'win32') throw new Error('Windows application packaging requires a Windows host')
  const errors = []
  for (const file of ['node_modules/electron-vite/bin/electron-vite.js', 'node_modules/electron-builder/cli.js']) {
    try { u.assertFile(path.join(ROOT, file)) } catch { errors.push('Missing application build dependency: ' + file) }
  }
  for (const name of ['yazl', 'yauzl', '@electron/asar', 'js-yaml']) {
    try { require.resolve(name) } catch { errors.push('Missing application packaging dependency: ' + name) }
  }
  for (const name of Object.keys(require('../package.json').dependencies || {})) {
    try { u.assertFile(path.join(ROOT, 'node_modules', name, 'package.json')) } catch { errors.push('Missing runtime application dependency: ' + name) }
  }
  try { require('./build-startup-helper.cjs').compilerPath(); runtime.applicationConfiguration(ROOT) } catch (error) { errors.push(error.message) }
  const result = { version: VERSION, architectures, node: process.version, errors, timestamp: new Date().toISOString() }
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'preflight.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  if (errors.length) throw new Error(errors.join('\n'))
  return result
}

module.exports = { ROOT, VERSION, EDITION, TARGETS, REQUIRED_RUNTIME_FILES, run, validateArchitectures, applicationPackageInputs,
  prepareNativeResources, preflight, buildApplications, verifyRuntime, verifyNativeFiles, verifyApplication, applicationFingerprint }
