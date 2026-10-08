'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { spawnSync } = require('node:child_process')
const u = require('./uninstaller-build-utils.cjs')
const build = require('./build-tauri-installer.cjs')
const distribution = require('./application-distribution.cjs')
const signing = require('./test-fixtures/distribution-signing.cjs')
const portable = require('./pack-portable.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-windows-package-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function pe(arch) {
  const bytes = Buffer.alloc(1024)
  bytes.write('MZ')
  bytes.writeUInt32LE(128, 0x3c)
  bytes.write('PE\0\0', 128)
  bytes.writeUInt16LE(u.MACHINES[arch], 132)
  bytes.writeUInt16LE(1, 134)
  bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(0x20b, 152)
  bytes.writeUInt32LE(512, 212)
  bytes.writeUInt32LE(512, 408)
  bytes.writeUInt32LE(512, 412)
  return bytes
}

function application(directory, arch) {
  const resources = path.join(directory, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SidekickAI.exe'), pe(arch))
  fs.writeFileSync(path.join(resources, 'app.asar'), `shared application ${arch}`)
  fs.writeFileSync(path.join(resources, 'License.txt'), 'license')
  const native = path.join(resources, 'app.asar.unpacked', 'node_modules', 'native')
  fs.mkdirSync(native, { recursive: true })
  fs.writeFileSync(path.join(native, 'binding.node'), pe(arch))
  return directory
}

test('setup assemblies preserve the selected distribution role and refuse duplicate or mismatched bytes', t => {
  const root = fixture(t)
  const signer = signing.createSigner()
  const edition = require('../product-edition.json').edition
  const online = edition === 'community'
  const targets = online ? ['x64'] : ['x64', 'arm64']
  for (const arch of targets) {
    const payload = path.join(root, 'application-' + arch + '.zip')
    const payloadBytes = Buffer.from('application archive ' + arch)
    fs.writeFileSync(payload, payloadBytes)
    const proof = distribution.signEnvelope(signing.bodyPayload({ edition, arch, version: build.VERSION, archive: payloadBytes }),
      distribution.PURPOSES.body, signer)
    const manifest = require('./gen-install-manifest.cjs').generateManifest(build.ROOT,
      { targetArchitecture: arch, distributionProof: online ? null : proof })
    const wizard = path.join(root, 'wizard-' + arch + '.exe')
    fs.writeFileSync(wizard, require('./test-fixtures/versioned-pe.cjs')(arch))
    const args = [root, wizard, online ? null : payload, online ? ['x64', 'arm64'] : [arch], manifest, { trust: signer.trust }]
    const setup = build.appendSetup(...args)
    const bytes = fs.readFileSync(setup)
    const parsed = require('./setup-metadata.cjs').readMetadata(bytes)
    assert.equal(u.peInfo(bytes).arch, arch)
    assert.equal(parsed.layout.sevenz, 0)
    assert.equal(parsed.layout.payload, online ? 0 : payloadBytes.length)
    assert.deepEqual(bytes.subarray(parsed.layout.wizard, parsed.layout.wizard + parsed.layout.payload), online ? Buffer.alloc(0) : payloadBytes)
    const suffix = online ? 'online' : arch
    const evidence = JSON.parse(fs.readFileSync(path.join(root, 'setup-' + suffix + '-evidence.json')))
    assert.equal(evidence.sha256, u.sha256(setup))
    assert.deepEqual(evidence.supportedNativeArchitectures, online ? ['x64', 'arm64'] : [arch])
    assert.throws(() => build.appendSetup(...args), /already exists/)
    assert.deepEqual(fs.readFileSync(setup), bytes)
    assert.throws(() => build.appendSetup(root, setup, args[2], args[3], manifest), /already carries/)
    if (!online) {
      const changed = structuredClone(manifest)
      changed.distributionProof.payload.productVersion = '0.9.0'
      assert.throws(() => build.appendSetup(path.join(root, 'tampered-' + arch), wizard, payload, [arch], changed, { trust: signer.trust }), /body mismatch/)
    }
  }
  const mismatched = require('./gen-install-manifest.cjs').generateManifest()
  mismatched.executableArchitecture = 'arm64'
  assert.throws(() => build.appendSetup(root, path.join(root, 'wizard-x64.exe'), null, ['x64', 'arm64'], mismatched), /architecture/)
})

function runtimeFixture(root) {
  const runtimeRoot = path.join(root, 'runtime')
  for (const arch of ['x64', 'arm64']) {
    const directory = path.join(runtimeRoot, arch)
    fs.mkdirSync(directory, { recursive: true })
    const files = { 'node.exe': pe(arch), 'export.mjs': Buffer.from('export {}'),
      'sidekick-backup.cjs': Buffer.from('module.exports = {}') }
    const zip = new AdmZip()
    for (const [name, bytes] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, name), bytes)
      zip.addFile(name, bytes)
    }
    zip.writeZip(path.join(runtimeRoot, 'win-' + arch + '.zip'))
  }
  return runtimeRoot
}

function maintenanceFixture(root, name, arch) {
  const artifact = path.join(root, name + '-' + arch + '.exe')
  fs.writeFileSync(artifact, pe(arch))
  const contract = require('./component-contract.cjs').readContract()
  return { artifact, manifest: { protocolVersion: 3, edition: require('../product-edition.json').edition,
    componentVersion: contract.componentVersion, uninstallProtocolVersion: contract.uninstallProtocolVersion,
    arch, sha256: u.sha256(artifact), size: fs.statSync(artifact).size, inputFingerprint: 'f'.repeat(64) } }
}

test('installed payloads contain one native application and one independently signed recovery runtime', t => {
  if (!fs.existsSync(process.env.SIDEKICK_7Z || 'C:/Program Files/7-Zip/7z.exe')) return t.skip('7-Zip is unavailable')
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const signer = signing.createSigner()
  const runtimeRoot = runtimeFixture(root)
  const uninstallers = {}, recoveryEntries = {}
  for (const arch of ['x64', 'arm64']) {
    application(path.join(applications, build.TARGETS[arch].directory), arch)
    uninstallers[arch] = maintenanceFixture(root, 'uninstaller', arch)
    recoveryEntries[arch] = maintenanceFixture(root, 'recovery', arch)
  }
  for (const arch of ['x64', 'arm64']) {
    const output = path.join(root, 'payload-' + arch)
    const source = path.join(applications, build.TARGETS[arch].directory)
    const before = build.applicationFingerprint(source)
    const result = build.buildPayload(output, applications, uninstallers, [arch],
      { signer, runtimeRoot, preparedRuntime: true, recoveryEntries })
    assert.deepEqual(build.applicationFingerprint(source), before)
    assert.deepEqual(result.proof.payload.nativeArchitectures, [arch])
    assert.equal(result.proof.payload.components.length, 1)
    assert.equal(result.bodyProofSha256, distribution.hash(Buffer.from(distribution.canonicalJson(result.proof.payload))))
    const container = new AdmZip(result.container.path)
    assert.deepEqual(container.getEntries().map(entry => entry.entryName).sort(), ['application.zip', 'body-proof.json'])
    const archive = new AdmZip(container.readFile('application.zip'))
    const names = archive.getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName).sort()
    assert.ok(names.includes('recover.exe') && names.includes('maintenance/backup-runtime.zip') && names.includes('maintenance/runtime-proof.json'))
    assert.ok(!names.some(name => /^(?:win-unpacked|win-arm64-unpacked|data)(?:\/|$)/.test(name)))
    assert.ok(result.proof.payload.files.every(file => file.executableArchitecture === null || file.executableArchitecture === arch))
    const runtimeProof = JSON.parse(archive.readFile('maintenance/runtime-proof.json').toString())
    assert.equal(distribution.verifyEnvelope(runtimeProof, distribution.PURPOSES.runtime, signer.trust).payload.nativeArchitecture, arch)
    u.verifyArtifact(path.join(result.staging, 'uninstall.exe'), u.deploymentManifest(uninstallers[arch].manifest, build.VERSION), arch, build.VERSION)
    fs.appendFileSync(result.archive.path, 'tampered')
    assert.throws(() => distribution.packagePayload(result.archive.path, result.proof, path.join(root, 'tampered-' + arch + '.zip'), signer), /does not match/)
  }
  assert.throws(() => build.buildPayload(path.join(root, 'mixed'), applications, uninstallers, ['x64', 'arm64'],
    { signer, runtimeRoot, preparedRuntime: true, recoveryEntries }), /exactly one/)
  assert.throws(() => build.buildPayload(path.join(root, 'wrong-recovery'), applications, uninstallers, ['x64'],
    { signer, runtimeRoot, preparedRuntime: true, recoveryEntries: { x64: recoveryEntries.arm64 } }), /ARCH_MISMATCH/)
  fs.writeFileSync(path.join(runtimeRoot, 'arm64/node.exe'), pe('x64'))
  assert.throws(() => build.buildPayload(path.join(root, 'wrong-runtime'), applications, uninstallers, ['arm64'],
    { signer, runtimeRoot, preparedRuntime: true, recoveryEntries }), /native binary/)
})

test('the green archive binds two native applications and recovery entries while excluding installation and user data', async t => {
  if (!fs.existsSync(process.env.SIDEKICK_7Z || 'C:/Program Files/7-Zip/7z.exe')) return t.skip('7-Zip is unavailable')
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const runtimeRoot = runtimeFixture(root)
  const signer = signing.createSigner()
  const recoveryEntries = {}
  for (const arch of ['x64', 'arm64']) {
    const directory = path.join(applications, build.TARGETS[arch].directory)
    for (const name of portable.REQUIRED_RUNTIME_FILES) {
      if (name === 'resources/app.asar') continue
      const file = path.join(directory, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, /\.(?:exe|dll)$/i.test(name) ? pe(arch) : Buffer.from('fixture ' + name))
    }
    const packageRoot = path.join(root, 'asar-' + arch)
    const loader = 'node_modules/node-gyp-build/node-gyp-build.js'
    fs.mkdirSync(path.dirname(path.join(packageRoot, loader)), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: require('../packages/product-contract/manifest.json').editions.concept.packageName, version: build.VERSION }))
    fs.copyFileSync(path.join(path.dirname(require.resolve('node-gyp-build/package.json')), 'node-gyp-build.js'), path.join(packageRoot, loader))
    await require('@electron/asar').createPackage(packageRoot, path.join(directory, 'resources/app.asar'))
    const native = path.join(directory, 'resources/app.asar.unpacked/node_modules')
    for (const name of ['better-sqlite3/prebuilds/win32-' + arch + '.node', 'uiohook-napi/prebuilds/win32-' + arch + '/uiohook-napi.node']) {
      fs.mkdirSync(path.dirname(path.join(native, name)), { recursive: true })
      fs.writeFileSync(path.join(native, name), pe(arch))
    }
    distribution.writeApplicationConfiguration(directory, { origin: 'http://localhost:4318', keys: signer.trust, resourceKeys: [] })
    recoveryEntries[arch] = maintenanceFixture(root, 'green-recovery', arch)
  }
  const output = path.join(root, 'green')
  const [artifact] = portable.packPortable({ output, applications, recoveryEntries, signer, runtimeRoot, minimumZipBytes: 1 })
  const zip = new AdmZip(artifact.path)
  const names = zip.getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName)
  assert.ok(names.includes('SidekickAI/Start-SidekickAI.cmd'))
  assert.ok(names.includes('SidekickAI/win-unpacked/recover.exe') && names.includes('SidekickAI/win-arm64-unpacked/recover.exe'))
  assert.ok(!names.some(name => /(?:^|\/)(?:uninstall\.exe|install-receipt\.json|data\/)/.test(name)))
  const proof = JSON.parse(zip.readFile('SidekickAI/distribution-proof.json').toString())
  assert.deepEqual(distribution.verifyEnvelope(proof, distribution.PURPOSES.body, signer.trust).payload.nativeArchitectures, ['x64', 'arm64'])
  assert.equal(proof.payload.variant, 'portable')
  assert.equal(proof.payload.archive, null)
  assert.equal(proof.payload.components.length, 2)
  assert.equal(artifact.bodyProofSha256, distribution.hash(Buffer.from(distribution.canonicalJson(proof.payload))))
  assert.deepEqual(names.filter(name => !name.endsWith('/distribution-proof.json')).map(name => name.slice('SidekickAI/'.length)).sort(),
    proof.payload.files.map(file => file.path).sort())
  assert.throws(() => portable.packPortable({ output, applications, recoveryEntries, signer, runtimeRoot, minimumZipBytes: 1 }), /already exists/)
  for (const name of ['resources/oxy-deployment.json', 'oxy-service.json', 'data/chat.db', 'maintenance/uninstall.exe']) {
    assert.throws(() => portable.validatePortablePath(name), /non-distributable|user data/)
  }
})

test('the Cargo target root is overridable without changing which sources compile', t => {
  const previous = process.env.SIDEKICK_CARGO_TARGET_DIR
  try {
    delete process.env.SIDEKICK_CARGO_TARGET_DIR
    const fallback = build.cargoTargetDir('x64', true)
    assert.ok(path.isAbsolute(fallback))
    assert.equal(fallback, path.join(build.ROOT, 'build', 'cargo-targets', 'uninstaller-x64'))
    assert.equal(build.cargoTargetDir('arm64', false), path.join(build.ROOT, 'build', 'cargo-targets', 'installer'))

    const root = path.join(os.tmpdir(), 'sidekick-cargo-root')
    process.env.SIDEKICK_CARGO_TARGET_DIR = root
    assert.equal(build.cargoTargetDir('x64', true), path.join(root, 'uninstaller-x64'))
    assert.equal(build.cargoTargetDir('arm64', true), path.join(root, 'uninstaller-arm64'))
    assert.equal(build.cargoTargetDir('x64', false), path.join(root, 'installer-x64'))
    assert.equal(fs.existsSync(root), false, 'resolving a target root must not create it')
  } finally {
    if (previous === undefined) delete process.env.SIDEKICK_CARGO_TARGET_DIR
    else process.env.SIDEKICK_CARGO_TARGET_DIR = previous
  }
})

test('Windows architectures reject duplicates and unsupported values', () => {
  for (const values of [[], ['x64', 'x64'], ['ia32'], 'arm64']) assert.throws(() => build.validateArchitectures(values), /architectures/)
  assert.deepEqual(build.validateArchitectures(['arm64']), ['arm64'])
})
