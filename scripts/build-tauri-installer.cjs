'use strict'

// Build into isolated directories and preserve existing release artifacts.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const u = require('./uninstaller-build-utils.cjs')
const webVerify = require('./verify-embedded-web.cjs')
const cache = require('./build-cache.cjs')
const maintenanceInputs = require('./maintenance-inputs.cjs')
const componentContract = require('./component-contract.cjs')
const setupMetadata = require('./setup-metadata.cjs')
const buildEvidence = require('./build-evidence.cjs')
const { toolInputs } = require('./build-tool-inputs.cjs')
const { withPackagingLock } = require('./packaging-lock.cjs')
const ROOT = path.resolve(__dirname, '..')
const INSTALLER = path.join(ROOT, 'installer-tauri')
const UNINSTALLER = path.join(ROOT, 'uninstaller-tauri')
const EDITION = JSON.parse(fs.readFileSync(path.join(ROOT, 'product-edition.json'), 'utf8')).edition
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const COMPONENT_VERSION = componentContract.componentVersion()
const TARGETS = {
  x64: { triple: 'x86_64-pc-windows-msvc', directory: 'win-unpacked' },
  arm64: { triple: 'aarch64-pc-windows-msvc', directory: 'win-arm64-unpacked' },
}
const OUTPUT_ROOT = path.join(ROOT, 'build', 'standalone-uninstaller')
const SEVENZ = process.env.SIDEKICK_7Z || 'C:\\Program Files\\7-Zip\\7z.exe'
const SEVENZR = path.join(ROOT, 'build', 'tools', '7zr.exe')

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
      env: { ...process.env, TAURI_ENV_PLATFORM: 'windows', ...(options.env || {}) },
    })
  } finally { if (output !== undefined) fs.closeSync(output) }
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: exit ${result.status}, signal ${result.signal || 'none'}`)
  console.log(`[timing] ${label}: ${Date.now() - started} ms`)
}

function tools() {
  // Explicit shared build tools are not runtime app dependencies; this imports
  // neither installer frontend nor installer engine into the standalone target.
  const modules = process.env.SIDEKICK_TAURI_NODE_MODULES
    ? path.resolve(process.env.SIDEKICK_TAURI_NODE_MODULES)
    : path.join(INSTALLER, 'node_modules')
  const result = { modules, tsc: path.join(modules, 'typescript', 'bin', 'tsc'), tauri: path.join(modules, '@tauri-apps', 'cli', 'tauri.js') }
  for (const file of [result.tsc, result.tauri, path.join(modules, '@tauri-apps', 'api', 'package.json')]) u.assertFile(file)
  // The shared web build resolves Vite itself, so only its presence is asserted here.
  result.vite = path.join(modules, 'vite', 'dist', 'node', 'index.js')
  result.webBuild = path.join(__dirname, 'tauri-web-build.cjs')
  u.assertFile(result.vite)
  u.assertFile(result.webBuild)
  console.log(`[build] Explicit shared build toolchain: ${modules}`)
  return result
}

function sourceInputs(app) {
  return maintenanceInputs.sourceInputs(app)
}

/**
 * Identity of the installed web bundler CLI tools. Vite bundles the application
 * frontend with esbuild and rollup, so a changed tool (or a changed native
 * binary package) must invalidate every cached native artifact that embedded the
 * web output. Both the resolved versions and the actual native bytes are captured.
 */
function dependencyToolIdentity(root = ROOT) {
  const requireRoot = createRequire(path.join(root, 'package.json'))
  const identity = {}
  for (const name of ['esbuild', 'rollup']) {
    try {
      const manifestPath = requireRoot.resolve(`${name}/package.json`)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const modules = path.join(path.dirname(manifestPath), '..')
      const platforms = Object.keys(manifest.optionalDependencies || {})
        .filter(dependency => /^@esbuild\/|^@rollup\/rollup-/.test(dependency))
        .map(dependency => ({ name: dependency, directory: path.join(modules, ...dependency.split('/')) }))
        .filter(entry => fs.existsSync(entry.directory))
      identity[name] = {
        version: manifest.version,
        platforms: Object.fromEntries(platforms.map(entry => [entry.name, JSON.parse(fs.readFileSync(path.join(entry.directory, 'package.json'), 'utf8')).version])),
        // The native binary package is the actual tool: hash its bytes, not just its name.
        fingerprint: u.fingerprint(root, platforms.map(entry => entry.directory)).fingerprint,
      }
    } catch (error) {
      identity[name] = { unresolved: error.code || error.message }
    }
  }
  return identity
}

function frontendTools(toolchain, native = false) {
  const names = ['vite', '@tauri-apps/api', '@vitejs/plugin-react', 'react', 'react-dom', '@types/react', '@types/react-dom', '@types/node']
  return [...new Set([
    ...toolInputs(path.dirname(toolchain.modules), [...names, 'typescript', ...(native ? ['@tauri-apps/cli'] : [])]),
    ...toolInputs(INSTALLER, names),
    ...toolInputs(ROOT, ['react', 'react-dom', '@types/react', '@types/react-dom', '@types/node']),
  ])].sort()
}

function compilerIdentity(toolchain, arch) {
  if (!toolchain.identities) toolchain.identities = {}
  if (toolchain.identities[arch]) return toolchain.identities[arch]
  const versions = ['rustc', 'cargo'].map(command => {
    const result = spawnSync(command, ['--version', '--verbose'], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error(`Cannot identify ${command}: ${result.error?.message || result.stderr}`)
    return result.stdout
  })
  const environment = Object.fromEntries(Object.entries({ ...process.env, ...toolchain.environments?.[arch] })
    .filter(([key]) => /^(PATH|LIB|LIBPATH|INCLUDE|VCToolsInstallDir|WindowsSdkDir|WindowsSDKVersion|CARGO_TARGET_.*_(?:LINKER|RUSTFLAGS)|CARGO_PROFILE_|CARGO_BUILD_|RUSTC(?:$|_)|CC_|CXX_)/i.test(key)))
  const webTools = frontendTools(toolchain, true)
  const identity = u.hash(JSON.stringify({ versions, node: process.version, environment, webTools: u.fingerprint(ROOT, webTools).fingerprint }))
  toolchain.identities[arch] = identity
  return identity
}

function nativeInputs(app, arch, toolchain) {
  if (process.env.CARGO_ENCODED_RUSTFLAGS || process.env.RUSTFLAGS) throw new Error('Unset RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS for verified builds')
  const source = u.fingerprint(ROOT, sourceInputs(app))
  const cloud = app === INSTALLER ? require('./oxy-build-config.cjs').cloudBuildEnvironment() : null
  return { version: COMPONENT_VERSION, fingerprint: u.hash(JSON.stringify({ source: source.fingerprint, arch, version: COMPONENT_VERSION,
    tools: compilerIdentity(toolchain, arch), cloud, command: nativeBuildArguments(app, arch),
    config: { build: { beforeBuildCommand: '', frontendDist: '../dist' } } })), inputs: source }
}

function validateArchitectures(architectures) {
  if (!Array.isArray(architectures) || !architectures.length || architectures.some(arch => !Object.hasOwn(TARGETS, arch)) || new Set(architectures).size !== architectures.length) {
    throw new Error('Expected a nonempty list of unique Windows architectures: x64, arm64')
  }
  return architectures
}

/** Read the maintenance component version under the Cargo package table. */
function readCargoPackageVersion(cargoTomlPath) {
  const source = fs.readFileSync(cargoTomlPath, 'utf8')
  let inPackage = false
  for (const line of source.split(/\r?\n/)) {
    if (/^\[package\]\s*$/.test(line)) {
      inPackage = true
      continue
    }
    if (inPackage && /^\[/.test(line)) break
    if (inPackage) {
      const version = line.match(/^\s*version\s*=\s*"([^"]+)"/)?.[1]
      if (version) return version
    }
  }
  return null
}

function preflight(architectures, full, output, options = {}) {
  require('./check-node-version.cjs').assertNodeVersion()
  validateArchitectures(architectures)
  if (process.platform !== 'win32') throw new Error('Windows MSVC builds require a Windows host')
  fs.mkdirSync(output, { recursive: true })
  const toolchain = tools()
  toolchain.environments = options.environments || {}
  run(process.execPath, ['--version'], 'Node version')
  run('cargo', ['--version'], 'Cargo version')
  run('rustc', ['--version'], 'Rust compiler version')
  const targetsFile = path.join(output, 'installed-targets.txt')
  run('rustup', ['target', 'list', '--installed'], 'Installed Rust targets', { output: targetsFile })
  const installed = fs.readFileSync(targetsFile, 'utf8').split(/\s+/)
  const errors = []
  for (const arch of architectures) if (!installed.includes(TARGETS[arch].triple)) errors.push(`Missing Rust target ${TARGETS[arch].triple}; install target and ARM64 MSVC libraries before retrying`)
  for (const arch of architectures) {
    if (toolchain.environments[arch]) continue
    try {
      toolchain.environments[arch] = require('./windows-toolchain.cjs').loadMsvcEnvironment(arch).environment
    } catch (error) {
      errors.push(error.message)
    }
  }
  // Rust standard libraries alone do not establish a usable target linker.
  const probeSource = path.join(output, 'link-probe.rs')
  fs.writeFileSync(probeSource, 'fn main() {}\n')
  for (const arch of architectures) {
    if (!toolchain.environments[arch]) continue
    const probeOutput = path.join(output, `link-probe-${arch}.exe`)
    const probe = spawnSync('rustc', ['--target', TARGETS[arch].triple, '-o', probeOutput, probeSource], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...toolchain.environments[arch] } })
    if (probe.status !== 0) {
      const detail = `${probe.stderr || probe.error?.message || ''}`.trim().split('\n')[0]
      const hint = arch === 'arm64'
        ? ' Install the Visual Studio component "MSVC build tools for ARM64/ARM64EC" (provides Hostx64\\arm64\\link.exe and the ARM64 CRT); the Windows SDK ARM64 UCRT/um libs alone are not sufficient.'
        : ''
      errors.push(`Cannot link for ${TARGETS[arch].triple}: ${detail}.${hint}`)
    }
  }
  for (const app of full ? [UNINSTALLER, INSTALLER] : [UNINSTALLER]) {
    const configPath = path.join(app, 'src-tauri', 'tauri.conf.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (config.version !== COMPONENT_VERSION) errors.push(`Component version mismatch: ${app}: ${config.version} != ${COMPONENT_VERSION}`)
    // Cargo and Tauri must agree on the independently versioned component.
    const cargoToml = path.join(app, 'src-tauri', 'Cargo.toml')
    const cargoVersion = readCargoPackageVersion(cargoToml)
    if (cargoVersion !== COMPONENT_VERSION) errors.push(`Cargo package version mismatch: ${cargoToml}: ${cargoVersion ?? 'missing'} != ${COMPONENT_VERSION}`)
    if (app === UNINSTALLER && (config.bundle.resources || config.bundle.externalBin)) errors.push('Standalone Tauri resources/externalBin are forbidden')
    u.assertFile(path.join(app, 'src-tauri', 'Cargo.lock'))
    // The wizard and the standalone uninstaller must embed their UI. A frontendDist
    // that Tauri reads as a URL (any absolute path - Url::parse accepts `E:\app\dist`
    // as scheme `e:`) silently skips embedding and leaves both showing a directory
    // index or "file not found" at runtime.
    try {
      webVerify.assertEmbeddableFrontendDist(config.build?.frontendDist, `${path.relative(ROOT, configPath)} frontendDist`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  if (full) {
    for (const file of [SEVENZ, SEVENZR, path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')]) {
      try { u.assertFile(file) } catch { errors.push(`Missing full Setup build dependency: ${file}`) }
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const requireRoot = createRequire(path.join(ROOT, 'package.json'))
    for (const name of Object.keys(pkg.dependencies || {})) {
      try { requireRoot.resolve(name) } catch { errors.push(`Missing runtime application dependency: ${name}; full Setup cannot be built`) }
    }
    for (const [arch, target] of Object.entries(TARGETS)) {
      const directory = path.join(ROOT, 'dist', target.directory)
      console.log(`[preflight] Existing ${arch} directory: ${fs.existsSync(directory) ? directory : 'missing; full build generates a new isolated directory'}`)
    }
  }
  const { environments, ...publicToolchain } = toolchain
  fs.writeFileSync(path.join(output, 'preflight.json'), JSON.stringify({ version: VERSION, architectures, full, toolchain: publicToolchain, errors, timestamp: new Date().toISOString() }, null, 2) + '\n')
  if (errors.length) throw new Error(errors.join('\n'))
  return toolchain
}

function buildWeb(app, toolchain) {
  const started = Date.now()
  const before = u.fingerprint(ROOT, maintenanceInputs.frontendInputs(app))
  const cloud = app === INSTALLER ? require('./oxy-build-config.cjs').cloudBuildEnvironment() : {}
  const webTools = frontendTools(toolchain)
  const toolsBefore = u.fingerprint(ROOT, webTools)
  const key = u.hash(JSON.stringify({ source: before.fingerprint, tools: toolsBefore,
    node: process.version, environment: { TAURI_ENV_PLATFORM: 'windows', TAURI_ENV_DEBUG: process.env.TAURI_ENV_DEBUG || '', ...cloud } }))
  if (!toolchain.frontends) toolchain.frontends = new Map()
  const previous = toolchain.frontends.get(app)
  if (previous?.key === key) {
    u.assertUnchanged(previous.web, u.fingerprint(ROOT, [path.join(app, 'dist')]))
    return previous.web
  }
  const name = `${path.basename(app)}-web`
  const decision = cache.inspect(name, key)
  if (decision.value) {
    const destination = path.join(app, 'dist')
    const expected = cache.snapshot(decision.value.directory)
    if (!fs.existsSync(destination) || cache.snapshot(destination) !== expected) {
      if (path.dirname(path.resolve(destination)) !== path.resolve(app)) throw new Error('Unsafe frontend output directory')
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true })
      fs.cpSync(decision.value.directory, destination, { recursive: true, errorOnExist: true, force: false })
    }
    if (cache.snapshot(destination) !== expected) throw new Error('Frontend cache copy did not verify')
  } else {
    run(process.execPath, [toolchain.tsc, '--noEmit', '-p', path.join(app, 'tsconfig.json')], `${path.basename(app)} typecheck`, { cwd: app })
    run(process.execPath, [toolchain.webBuild], `${path.basename(app)} production web`, { cwd: app, env: app === INSTALLER ? require('./oxy-build-config.cjs').cloudBuildEnvironment() : {} })
    u.assertUnchanged(before, u.fingerprint(ROOT, maintenanceInputs.frontendInputs(app)))
    const directory = cache.retainDirectory(name, key, path.join(app, 'dist'))
    cache.remember(name, key, [directory], { directory })
  }
  const html = fs.readFileSync(path.join(app, 'dist', 'index.html'), 'utf8')
  if (/<script[^>]+src=["'](?:https?:|\/)/i.test(html)) throw new Error('Production entry references a remote or absolute script')
  u.assertUnchanged(before, u.fingerprint(ROOT, maintenanceInputs.frontendInputs(app)))
  u.assertUnchanged(toolsBefore, u.fingerprint(ROOT, webTools))
  const web = u.fingerprint(ROOT, [path.join(app, 'dist')])
  toolchain.frontends.set(app, { key, web })
  if (toolchain.evidenceOutput) buildEvidence.record(toolchain.evidenceOutput, name, key, decision, started, { outputFingerprint: web.fingerprint })
  return web
}

function nativeBuildArguments(app, arch) {
  return ['build', '--no-bundle', '--target', TARGETS[arch].triple, '--', '--offline', '--locked', '--jobs', '2']
}

/**
 * Cargo target directory for a product build. `SIDEKICK_CARGO_TARGET_DIR` allows a
 * constrained host to point compiled output at a writable volume without changing
 * which sources are compiled; the default stays inside the project build directory.
 */
function cargoTargetDir(arch, standalone) {
  const override = process.env.SIDEKICK_CARGO_TARGET_DIR
  if (override) return path.join(path.resolve(override), standalone ? `uninstaller-${arch}` : `installer-${arch}`)
  return path.join(ROOT, 'build', 'cargo-targets', standalone ? `uninstaller-${arch}` : 'installer')
}

function buildNative(app, arch, output, toolchain, standalone) {
  validateArchitectures([arch])
  fs.mkdirSync(output, { recursive: true })
  const before = u.fingerprint(ROOT, sourceInputs(app))
  const web = buildWeb(app, toolchain)
  u.assertUnchanged(before, u.fingerprint(ROOT, sourceInputs(app)))
  const inputFingerprint = u.hash(JSON.stringify({ source: nativeInputs(app, arch, toolchain).fingerprint, web: web.fingerprint }))
  const targetDir = cargoTargetDir(arch, standalone)
  const name = standalone ? 'sidekickai-uninstaller' : 'sidekickai-installer'
  const target = TARGETS[arch].triple
  const raw = path.join(targetDir, target, 'release', `${name}.exe`)
  const previous = fs.existsSync(raw) ? u.sha256(raw) : null
  if (process.env.CARGO_ENCODED_RUSTFLAGS || process.env.RUSTFLAGS) throw new Error('Unset RUSTFLAGS/CARGO_ENCODED_RUSTFLAGS for verified builds')
  // Only beforeBuildCommand is overridden: the web build already ran above with the
  // Tauri production markers. `frontendDist` must keep coming from tauri.conf.json.
  // An absolute path here is parsed by tauri-utils as a URL (`Url::parse` reads
  // `E:\...\dist` as scheme `e:`), which silently skips asset embedding and makes the
  // wizard load its UI from this build machine at runtime.
  const production = {
    build: {
      beforeBuildCommand: '',
      frontendDist: path.relative(path.join(app, 'src-tauri'), path.join(app, 'dist')),
    },
  }
  webVerify.assertEmbeddableFrontendDist(production.build.frontendDist, `${name} ${arch} frontendDist`)
  const config = path.join(output, `${name}-${arch}-production.json`)
  fs.writeFileSync(config, JSON.stringify(production, null, 2))
  const arguments_ = nativeBuildArguments(app, arch)
  arguments_.splice(arguments_.indexOf('--'), 0, '--config', config)
  run(process.execPath, [toolchain.tauri, ...arguments_], `${name} ${arch} Tauri production`, {
    cwd: app, env: { ...toolchain.environments?.[arch], ...(app === INSTALLER ? require('./oxy-build-config.cjs').cloudBuildEnvironment() : {}), CARGO_TARGET_DIR: targetDir, SIDEKICK_BUILD_FINGERPRINT: inputFingerprint },
  })
  u.assertUnchanged(before, u.fingerprint(ROOT, sourceInputs(app)))
  u.assertUnchanged(web, u.fingerprint(ROOT, [path.join(app, 'dist')]))
  const info = standalone ? u.assertStandaloneBinary(raw, arch) : { ...u.peInfo(fs.readFileSync(raw)), sha256: u.sha256(raw) }
  if (info.arch !== arch) throw new Error('Native wizard architecture mismatch')
  // The whole point of the build: the UI must travel inside the executable.
  const webEvidence = webVerify.verifyEmbeddedWebAssets(app, {
    targetDir,
    targetTriple: target,
    cratePrefix: name,
    executable: raw,
  })
  const depfile = path.join(targetDir, target, 'release', `${name}.d`)
  const dependency = standalone ? u.assertDependencyBoundary(depfile) : null
  const directory = path.join(output, standalone ? 'uninstaller' : 'wizard', arch)
  fs.mkdirSync(directory, { recursive: true })
  const artifact = path.join(directory, `${name}.exe`)
  fs.copyFileSync(raw, artifact, fs.constants.COPYFILE_EXCL)
  if (u.sha256(artifact) !== info.sha256) throw new Error('Copied executable differs from raw build output')
  const manifest = { protocolVersion: 2, edition: EDITION, componentVersion: COMPONENT_VERSION,
    uninstallProtocolVersion: componentContract.readContract().uninstallProtocolVersion, arch, sha256: info.sha256, size: info.size, inputFingerprint }
  fs.writeFileSync(path.join(directory, standalone ? 'uninstall-manifest.json' : 'wizard-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, 'build-evidence.json'), JSON.stringify({ raw, artifact, manifest, previousRawSha256: previous, sourceInputs: before, webInputs: web, webEvidence, dependency, pe: info, productionConfig: config, productionConfigValues: production }, null, 2) + '\n')
  console.log(`[build] ${artifact}: ${info.size} bytes, ${arch}, SHA-256 ${info.sha256}, embedded UI ${webEvidence.files.length} files / ${webEvidence.streams} streams`)
  return { artifact, manifest, webEvidence }
}

function applicationPackageInputs() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const packages = Object.entries(lock.packages || {})
    .filter(([name, entry]) => name.startsWith('node_modules/') && !entry.dev && fs.existsSync(path.join(ROOT, name)))
    .map(([name]) => path.join(ROOT, name))
  return ['out', 'resources', 'packages/product-contract', 'packages/desktop-common', 'product-edition.json', 'electron-builder.yml', 'package.json', 'package-lock.json',
    'scripts/verify-packaged-ui.cjs', 'scripts/check-node-version.cjs', 'scripts/verify-packaged-native.cjs', 'build/License.txt', 'LICENSE',
    'node_modules/electron/package.json', 'node_modules/electron-builder', 'node_modules/app-builder-lib']
    .map(file => path.join(ROOT, file)).filter(file => fs.existsSync(file)).concat(packages, process.env.SIDEKICK_ELECTRON_DIST ? [path.resolve(process.env.SIDEKICK_ELECTRON_DIST)] : [], [__filename])
    .flatMap(file => fs.statSync(file).isDirectory() ? u.listFiles(file, new Set(['.git'])) : [file])
}

function buildApplications(output, architectures, options = {}) {
  require('./check-node-version.cjs').assertNodeVersion()
  validateArchitectures(architectures)
  const appOutput = path.join(output, 'application-build')
  if (fs.existsSync(appOutput)) throw new Error(`Application build directory already exists: ${appOutput}`)
  fs.mkdirSync(appOutput, { recursive: true })
  const inputs = ['electron', 'src', 'resources', 'packages/product-contract', 'packages/desktop-common', 'product-edition.json', 'package.json', 'package-lock.json', 'electron-builder.yml', 'electron.vite.config.ts', 'scripts/compilation-inputs.ts', 'scripts/verify-packaged-ui.cjs', 'scripts/check-node-version.cjs', 'scripts/verify-packaged-native.cjs', 'build/License.txt', 'LICENSE'].map(file => path.join(ROOT, file)).filter(file => fs.existsSync(file))
  const before = u.fingerprint(ROOT, inputs)
  const compilation = require('./application-build.cjs').compile(output, run)
  const packageInputs = applicationPackageInputs()
  const packageBefore = u.fingerprint(ROOT, packageInputs)
  const signing = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(CSC_|WIN_CSC_|SIGN_|ELECTRON_)/.test(key)))
  const evidence = {}
  for (const arch of architectures) {
    const started = Date.now()
    const key = u.hash(JSON.stringify({ inputs: packageBefore.fingerprint, arch, node: process.version, signing }))
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
    const args = [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--dir', `--${arch}`, `--config.directories.output=${appOutput}`]
    if (process.env.SIDEKICK_ELECTRON_DIST) args.push(`--config.electronDist=${path.resolve(process.env.SIDEKICK_ELECTRON_DIST)}`)
    run(process.execPath, args, `Current ${arch} application directory`)
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

function verifyApplication(directory, arch) {
  validateArchitectures([arch])
  u.assertFile(path.join(directory, 'resources', 'app.asar'))
  if (fs.existsSync(path.join(directory, 'portable.txt'))) throw new Error(`Shared application directory already enables portable mode: ${directory}`)
  for (const file of ['uninstall.exe', 'uninstall-manifest.json']) {
    if (fs.existsSync(path.join(directory, file))) throw new Error(`Shared application directory already contains installer metadata: ${directory}`)
  }
  const packaged = JSON.parse(require('@electron/asar').extractFile(path.join(directory, 'resources/app.asar'), 'package.json').toString())
  const product = require('../packages/product-contract/manifest.json')
  if (packaged.name !== product.editions[EDITION].packageName || packaged.version !== VERSION) throw new Error('Application payload edition/version mismatch')
  const native = require('./verify-packaged-native.cjs').verifyPackagedNative(directory, arch)
  return { directory, arch, native, inputs: applicationFingerprint(directory) }
}

function applicationFingerprint(directory) {
  return u.fingerprint(directory, u.listFiles(directory, new Set()))
}

function buildPayload(output, applications, uninstallers, architectures, options = {}) {
  const started = Date.now()
  validateArchitectures(architectures)
  const compression = options.compression || 9
  if (![5, 9].includes(compression)) throw new Error('Unsupported payload compression')
  const sources = architectures.map(arch => path.join(applications, TARGETS[arch].directory))
  const key = u.hash(JSON.stringify({ applications: sources.map(applicationFingerprint), uninstallers: architectures.map(arch => u.deploymentManifest(uninstallers[arch].manifest, VERSION)), compression, tools: u.fingerprint(ROOT, [SEVENZ, SEVENZR, __filename]).fingerprint }))
  const decision = options.reuse ? cache.inspect('payload', key) : { reason: 'disabled' }
  const existing = options.reuse ? cache.load('payload', key) : null
  if (existing) {
    fs.mkdirSync(output, { recursive: true })
    const payload = path.join(output, 'payload.7z')
    fs.copyFileSync(existing.path, payload, fs.constants.COPYFILE_EXCL)
    // A copied cache entry is only reused after its bytes still hash to what the
    // record captured; otherwise the stale copy is discarded and rebuilt below.
    if (u.sha256(payload) !== existing.sha256) {
      console.log('[build] Cached installation payload no longer matches its record; rebuilding')
      fs.rmSync(payload, { force: true })
    } else {
      cache.atomicWrite(path.join(output, 'payload-evidence.json'), JSON.stringify({ ...existing, path: payload, reused: true }, null, 2) + '\n')
      buildEvidence.record(output, 'payload', key, { reason: 'matched' }, started, { sha256: existing.sha256 })
      console.log('[build] Reused verified installation payload')
      return payload
    }
  }
  const staging = path.join(output, 'payload-staging')
  fs.mkdirSync(output, { recursive: true })
  fs.mkdirSync(staging)
  const applicationInputs = {}
  for (const arch of architectures) {
    const target = TARGETS[arch]
    const source = path.join(applications, target.directory)
    const before = applicationFingerprint(source)
    applicationInputs[arch] = before
    const destination = path.join(staging, target.directory)
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
    u.assertUnchanged(before, applicationFingerprint(source))
    u.assertUnchanged(before, applicationFingerprint(destination))
    u.stageUninstaller(uninstallers[arch].artifact, uninstallers[arch].manifest, destination, arch, VERSION)
  }
  const before = applicationFingerprint(staging)
  const payload = path.join(output, 'payload.7z')
  if (fs.existsSync(payload)) throw new Error('Fresh payload path already exists; refusing archive update')
  const directories = architectures.map(arch => TARGETS[arch].directory)
  run(SEVENZ, ['a', '-t7z', `-mx=${compression}`, compression === 9 ? '-md=256m' : '-md=32m', '-ms=on', '-y', payload, ...directories], `Fresh ${architectures.join('+')} payload`, { cwd: staging })
  run(SEVENZ, ['t', payload], 'Verify fresh payload archive')
  run(SEVENZR, ['t', payload], 'Verify payload with the embedded extractor')
  u.assertUnchanged(before, applicationFingerprint(staging))
  const evidence = { architectures, applicationInputs, inputs: before, path: payload, sha256: u.sha256(payload), size: fs.statSync(payload).size }
  fs.writeFileSync(path.join(output, 'payload-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  const retained = cache.retainFile('payload', key, payload)
  cache.remember('payload', key, [retained], { ...evidence, path: retained })
  buildEvidence.record(output, 'payload', key, { reason: existing ? 'output-changed' : decision.reason }, started, { sha256: evidence.sha256 })
  return payload
}

function appendSetup(output, wizard, payload, architectures, manifest = require('./gen-install-manifest.cjs').generateManifest()) {
  const started = Date.now()
  validateArchitectures(architectures)
  const rawWizard = fs.readFileSync(wizard)
  const wizardArch = u.peInfo(rawWizard).arch
  if (!architectures.includes(wizardArch)) throw new Error('Setup executable architecture is missing from its application payload')
  if (u.footerInfo(rawWizard)) throw new Error('Raw wizard already carries a payload')
  const wizardBytes = setupMetadata.stampProductVersion(rawWizard, manifest.productVersion)
  const payloadBytes = fs.readFileSync(payload)
  const sevenzBytes = fs.readFileSync(SEVENZR)
  const metadata = setupMetadata.createMetadata(manifest, payloadBytes, sevenzBytes)
  const metadataBytes = Buffer.from(JSON.stringify(metadata))
  const footer = setupMetadata.footer(metadataBytes, payloadBytes.length, sevenzBytes.length)
  const suffix = wizardArch
  fs.mkdirSync(output, { recursive: true })
  const destination = path.join(output, `SidekickAI-Setup-${VERSION}-${suffix}.exe`)
  if (fs.existsSync(destination)) throw new Error('Setup destination already exists')
  cache.atomicWrite(destination, Buffer.concat([wizardBytes, payloadBytes, sevenzBytes, metadataBytes, footer]))
  const bytes = fs.readFileSync(destination)
  const info = u.footerInfo(bytes)
  setupMetadata.readMetadata(bytes)
  if (info.wizard !== wizardBytes.length || u.hash(bytes.subarray(0, info.wizard)) !== u.hash(wizardBytes)
    || u.hash(bytes.subarray(info.wizard, info.wizard + info.payload)) !== u.hash(payloadBytes)
    || u.hash(bytes.subarray(info.wizard + info.payload, info.metadataOffset)) !== u.hash(sevenzBytes)
    || u.hash(fs.readFileSync(wizard)) !== u.hash(rawWizard)) throw new Error('Setup appended bytes did not verify')
  const evidence = { path: destination, sha256: u.sha256(destination), size: bytes.length, architecture: wizardArch, payloadArchitectures: architectures,
    componentVersion: COMPONENT_VERSION, productVersion: manifest.productVersion, rawWizardSha256: u.hash(rawWizard), metadata, footer: info }
  fs.writeFileSync(path.join(output, `setup-${suffix}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n')
  console.log(`[build] Verified Setup (not published): ${destination}`)
  buildEvidence.record(output, 'setup', u.hash(JSON.stringify(metadata)), { reason: 'assembled' }, started, { sha256: evidence.sha256 })
  return destination
}

// Maintenance artifacts are addressed by production inputs, independent of releases.

const SHARED_COMPONENTS = path.join(ROOT, 'build', 'shared-components')

function componentCacheDirectory(name, cacheRoot = SHARED_COMPONENTS) {
  // The directory name is fixed by the caller, never by untrusted input.
  return path.join(cacheRoot, name.replace(/[^a-z0-9-]/gi, ''))
}

/** Content version of the shared uninstall implementation and both web frontends. */
function sharedComponentVersion(toolchain = tools(), arch = 'x64') {
  return nativeInputs(UNINSTALLER, arch, toolchain)
}

/** Reuse an already built component when its recorded inputs still match. */
function reuseComponent(name, arch, expected, cacheRoot = SHARED_COMPONENTS) {
  if (process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS === '1' || process.env.SIDEKICK_REBUILD_ALL === '1') return null
  const directory = componentCacheDirectory(name, cacheRoot)
  const record = path.join(directory, arch, `${expected.fingerprint}.json`)
  if (!fs.existsSync(record)) return null
  let cached
  try { cached = JSON.parse(fs.readFileSync(record, 'utf8')) } catch { return null }
  if (cached.name !== name || cached.arch !== arch || cached.version !== expected.version || cached.inputFingerprint !== expected.fingerprint) return null
  if (cached.protocolVersion !== 2 || !/^[a-f0-9]{64}$/.test(cached.executableSha256 || '')) return null
  const exe = path.join(directory, arch, 'objects', `${cached.executableSha256}.exe`)
  try {
    // A cached executable is only reused after it verifies against its stored manifest.
    const info = u.verifyComponentArtifact(exe, cached.manifest, arch, name === 'uninstaller')
    if (info.arch !== arch || info.sha256 !== cached.manifest.sha256 || info.size !== cached.manifest.size) return null
    return { artifact: exe, manifest: cached.manifest, reused: true, cached: record }
  } catch {
    return null
  }
}

function rememberComponent(name, arch, expected, built, webEvidence, cacheRoot = SHARED_COMPONENTS) {
  const directory = componentCacheDirectory(name, cacheRoot)
  fs.mkdirSync(directory, { recursive: true })
  const exe = path.join(directory, arch, 'objects', `${built.manifest.sha256}.exe`)
  const record = path.join(directory, arch, `${expected.fingerprint}.json`)
  u.verifyComponentArtifact(built.artifact, built.manifest, arch, name === 'uninstaller')
  cache.atomicWrite(exe, fs.readFileSync(built.artifact))
  const stored = { protocolVersion: 2, name, arch, version: expected.version, inputFingerprint: expected.fingerprint, manifest: built.manifest, webEvidence, storedAt: new Date().toISOString(), executableSha256: u.sha256(exe) }
  cache.atomicWrite(record, JSON.stringify(stored, null, 2) + '\n')
  return stored
}

/**
 * Build the standalone uninstaller for `arch`, or reuse the cached one.
 * The payload embedded by the Setup therefore carries the same bytes that the
 * previously verified standalone publishes, instead of a fresh rebuild.
 */
function buildOrReuseUninstaller(output, arch, toolchain) {
  const started = Date.now()
  toolchain.evidenceOutput = output
  const expected = sharedComponentVersion(toolchain, arch)
  const reused = reuseComponent('uninstaller', arch, expected)
  if (reused) {
    buildEvidence.record(output, `uninstaller-${arch}`, expected, { reason: 'matched' }, started, { sha256: reused.manifest.sha256 })
    console.log(`[build] Reusing cached uninstaller ${arch}: ${reused.artifact} (SHA-256 ${reused.manifest.sha256})`)
    return reused
  }
  const decision = componentDecision('uninstaller', arch, expected)
  const built = buildNative(UNINSTALLER, arch, output, toolchain, true)
  u.assertUnchanged(expected, sharedComponentVersion(toolchain, arch))
  rememberComponent('uninstaller', arch, expected, built, built.webEvidence)
  buildEvidence.record(output, `uninstaller-${arch}`, expected, decision, started, { sha256: built.manifest.sha256 })
  return built
}

function buildOrReuseWizard(output, arch, toolchain) {
  const started = Date.now()
  toolchain.evidenceOutput = output
  const expected = nativeInputs(INSTALLER, arch, toolchain)
  const reused = reuseComponent('wizard', arch, expected)
  if (reused) {
    buildEvidence.record(output, `wizard-${arch}`, expected, { reason: 'matched' }, started, { sha256: reused.manifest.sha256 })
    console.log(`[build] Reused verified ${arch} installer wizard`)
    return reused
  }
  const decision = componentDecision('wizard', arch, expected)
  const built = buildNative(INSTALLER, arch, output, toolchain, false)
  u.assertUnchanged(expected, nativeInputs(INSTALLER, arch, toolchain))
  rememberComponent('wizard', arch, expected, built, built.webEvidence)
  buildEvidence.record(output, `wizard-${arch}`, expected, decision, started, { sha256: built.manifest.sha256 })
  return built
}

function componentDecision(name, arch, expected) {
  if (process.env.SIDEKICK_REBUILD_SHARED_COMPONENTS === '1' || process.env.SIDEKICK_REBUILD_ALL === '1') return { reason: 'forced' }
  const directory = path.join(componentCacheDirectory(name), arch)
  const record = path.join(directory, `${expected.fingerprint}.json`)
  return { reason: fs.existsSync(record) ? 'missing-or-invalid-output' : fs.existsSync(directory) ? 'inputs-changed' : 'missing' }
}

/**
 * Runtime gate: launch the built Setup, read the page the webview actually loaded, and
 * require the wizard's own title. The byte-level check proves the assets are inside the
 * executable; this proves the whole path works, including the Tauri production protocol
 * and the asset resolver. A Setup shows its wizard without installing anything, so this
 * is safe, but it needs an interactive desktop session and a host that can actually run
 * the image - set SIDEKICK_SKIP_UI_PROBE=1 on a headless build machine.
 */
function probeSetupUi(setup, arch) {
  if (process.env.SIDEKICK_SKIP_UI_PROBE === '1') {
    console.log(`[build] UI probe skipped for ${arch} (SIDEKICK_SKIP_UI_PROBE=1)`)
    return { skipped: true }
  }
  const hostArches = process.env.PROCESSOR_ARCHITEW6432 ? [process.env.PROCESSOR_ARCHITEW6432.toLowerCase(), (process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase()] : [(process.env.PROCESSOR_ARCHITECTURE || '').toLowerCase()]
  if (arch === 'arm64' && !hostArches.includes('arm64')) {
    // x64 Windows cannot run ARM64 images, so the wizard cannot be launched here. The
    // asset check above already proved the UI is embedded; the runtime render is
    // verified on an ARM64 host or by the emulated install path.
    console.log(`[build] UI probe skipped for ${arch}: this host (${hostArches.join('+') || 'unknown'}) cannot run ARM64 images`)
    return { skipped: true, reason: 'host cannot execute arm64 images' }
  }
  const probe = path.join(__dirname, 'probe-native-ui.cjs')
  if (!fs.existsSync(probe)) throw new Error(`UI probe helper is missing: ${probe}`)
  const result = spawnSync(process.execPath, [probe, setup, '安装向导'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  let report
  try {
    report = JSON.parse((result.stdout || '').slice((result.stdout || '').indexOf('{')))
  } catch {
    throw new Error(`UI probe produced no report for ${arch} Setup (exit ${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 400)}`)
  }
  if (report.unrunnable) {
    console.log(`[build] UI probe skipped for ${arch}: ${report.error}`)
    return { skipped: true, reason: report.error }
  }
  if (!report.ok) {
    throw new Error(
      `Setup ${arch} does not render its embedded wizard UI: ${report.reason || report.error || 'unknown'} ` +
      `(webview url ${JSON.stringify(report.url)}, title ${JSON.stringify(report.title)}). ` +
      'This is the failure that shows a directory index or "file not found" instead of the installer.',
    )
  }
  console.log(`[build] Setup ${arch} renders the wizard UI (${report.url}, ${JSON.stringify(report.title)})`)
  return report
}

function buildInstallerArtifacts(output, applications, architectures, toolchain, options = {}) {
  validateArchitectures(architectures)
  // The payload MUST stay dual-architecture (the wizard reads PROCESSOR_ARCHITECTURE to pick win-unpacked
  // vs win-arm64-unpacked at install time, and the embedded uninstaller manifests must match the host
  // architecture). The wizard PE itself only needs the x64 build for the release surface: a single
  // Setup-x64.exe with a dual-architecture payload is enough to install on either native Windows, so
  // we do NOT publish a second Setup-arm64.exe. The arm64 wizard is still built locally for the
  // shared-component cache when its inputs change, gated by a future flag if ever needed.
  if (!architectures.includes('x64')) throw new Error('Setup requires an x64 wizard binary; the payload may still be dual-architecture')
  fs.mkdirSync(output, { recursive: true })
  const initialApplications = {}
  for (const arch of architectures) initialApplications[arch] = verifyApplication(path.join(applications, TARGETS[arch].directory), arch)
  const uninstallers = {}
  for (const arch of architectures) uninstallers[arch] = buildOrReuseUninstaller(output, arch, toolchain)
  const payload = buildPayload(output, applications, uninstallers, architectures, options)
  const currentManifest = require('./gen-install-manifest.cjs').generateManifest()
  cache.atomicWrite(path.join(output, 'setup-metadata.json'), JSON.stringify(currentManifest, null, 2) + '\n')
  const setups = {}
  const wizards = {}
  const standaloneUninstallers = {}
  const uiProbes = {}
  const wizardArch = 'x64'
  wizards[wizardArch] = buildOrReuseWizard(output, wizardArch, toolchain)
  setups[wizardArch] = appendSetup(output, wizards[wizardArch].artifact, payload, architectures, currentManifest)
  uiProbes[wizardArch] = probeSetupUi(setups[wizardArch], wizardArch)
  for (const arch of architectures) {
    const destination = path.join(output, `SidekickAI-Uninstaller-${VERSION}-${arch}.exe`)
    fs.copyFileSync(uninstallers[arch].artifact, destination, fs.constants.COPYFILE_EXCL)
    const deployedManifest = u.deploymentManifest(uninstallers[arch].manifest, VERSION)
    u.verifyArtifact(destination, deployedManifest, arch, VERSION)
    fs.writeFileSync(destination.replace(/\.exe$/, '.json'), JSON.stringify(deployedManifest, null, 2) + '\n', { flag: 'wx' })
    standaloneUninstallers[arch] = destination
    const directory = path.join(applications, TARGETS[arch].directory)
    u.assertUnchanged(initialApplications[arch].inputs, applicationFingerprint(directory))
  }
  const result = { applications, architectures, payload, setups, standaloneUninstallers, uninstallers, wizards, uiProbes }
  fs.writeFileSync(path.join(output, 'installer-artifacts.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

const USAGE = 'Usage: [--uninstaller all] [--preflight] | --web | --typecheck'

function main(args = process.argv.slice(2)) {
  return withPackagingLock(() => buildFromArguments(args))
}

async function buildFromArguments(args) {
  require('../packages/product-contract/sync.cjs').synchronize(ROOT)
  require('./shared-source.cjs').check(ROOT)
  require('./sync-versions.cjs').main(['--check'])
  const u = require('./uninstaller-build-utils.cjs')
  const preflightOnly = args.includes('--preflight')
  args = args.filter(arg => arg !== '--preflight')
  if (args[0] === '--web' || args[0] === '--typecheck') {
    if (args.length !== 1) throw new Error('Unexpected arguments')
    const toolchain = tools()
    if (args[0] === '--web') buildWeb(UNINSTALLER, toolchain)
    else run(process.execPath, [toolchain.tsc, '--noEmit', '-p', path.join(UNINSTALLER, 'tsconfig.json')], 'Standalone typecheck', { cwd: UNINSTALLER })
    return
  }
  const standalone = args[0] === '--uninstaller'
  let architectures
  if (standalone) {
    if (args.length !== 2 || args[1] !== 'all') throw new Error(USAGE)
    architectures = ['x64', 'arm64']
  } else {
    // Setup and payload are always dual-architecture; single-architecture entries are removed.
    if (args.length) throw new Error(USAGE)
    architectures = ['x64', 'arm64']
  }
  const output = u.uniqueOutput(OUTPUT_ROOT)
  console.log(`[build] Unique verification output (existing release untouched): ${output}`)
  const toolchain = preflight(architectures, !standalone, output)
  if (preflightOnly) return
  if (standalone) {
    for (const arch of architectures) {
      const built = buildOrReuseUninstaller(output, arch, toolchain)
      const destination = path.join(output, `SidekickAI-Uninstaller-${COMPONENT_VERSION}-${arch}.exe`)
      fs.copyFileSync(built.artifact, destination, fs.constants.COPYFILE_EXCL)
      fs.writeFileSync(destination.replace(/\.exe$/, '.json'), JSON.stringify(built.manifest, null, 2) + '\n', { flag: 'wx' })
    }
    return
  }
  return buildProducts(output, architectures, toolchain)
}

const nativeDependencies = {
  captureInputs: () => EDITION === 'community' ? require('./build-release.cjs').captureReleaseInputs() : u.fingerprint(ROOT, ['electron', 'src', 'packages', 'product-edition.json', 'package.json', 'electron.vite.config.ts'].map(file => path.join(ROOT, file))),
  buildPlugins: options => EDITION === 'community' ? require('./build-plugins.cjs').main(options) : Promise.resolve(),
  buildApplications: (output, architectures) => buildApplications(output, architectures, { reuse: true }),
  buildInstallerArtifacts: (output, applications, architectures, toolchain) => buildInstallerArtifacts(output, applications, architectures, toolchain, { reuse: true, compression: 5 }),
}

/**
 * Native packaging sequence after preflight. The plugin build is asynchronous
 * (esbuild runs per plugin) and must settle before the application packaging reads
 * resources/plugins, so a delayed or rejected plugin build stops the run instead of
 * packaging the previous output. Dependencies are injectable so the ordering is
 * verified without a real build.
 */
async function buildProducts(output, architectures, toolchain, dependencies = nativeDependencies) {
  const captureInputs = dependencies.captureInputs
  const before = captureInputs?.()
  await dependencies.buildPlugins({
    distRoot: path.join(output, 'plugins'),
    // 与 build-release 同一口径：安装包不随附插件资源树，ZIP 仍产出供云端/本地导入。
    shipBundledResources: false,
  })
  if (before) u.assertUnchanged(before, captureInputs())
  const applications = await dependencies.buildApplications(output, architectures)
  if (before) u.assertUnchanged(before, captureInputs())
  const result = await dependencies.buildInstallerArtifacts(output, applications, architectures, toolchain)
  if (before) u.assertUnchanged(before, captureInputs())
  return result
}

module.exports = { ROOT, VERSION, COMPONENT_VERSION, TARGETS, INSTALLER, UNINSTALLER, sourceInputs, nativeInputs, dependencyToolIdentity, validateArchitectures, run, tools, preflight, buildWeb, buildNative, cargoTargetDir, applicationFingerprint, verifyApplication, buildApplications, buildPayload, appendSetup, buildInstallerArtifacts, buildProducts, buildOrReuseUninstaller, reuseComponent, rememberComponent, sharedComponentVersion, componentCacheDirectory, probeSetupUi, readCargoPackageVersion, main, buildFromArguments }
if (require.main === module) {
  main().catch(error => {
    console.error(`[build] Failed: ${error.stack || error}`)
    process.exitCode = 1
  })
}
