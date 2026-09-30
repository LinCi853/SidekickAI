'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const u = require('./uninstaller-build-utils.cjs')
const build = require('./build-tauri-installer.cjs')

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

test('appendSetup still serves both architectures over one shared dual-arch payload', t => {
  const root = fixture(t)
  const payload = path.join(root, 'payload.7z')
  const payloadBytes = Buffer.from('one shared application payload')
  fs.writeFileSync(payload, payloadBytes)
  const setups = []
  for (const arch of ['x64', 'arm64']) {
    const wizard = path.join(root, `wizard-${arch}.exe`)
    fs.writeFileSync(wizard, require('./test-fixtures/versioned-pe.cjs')(arch))
    const setup = build.appendSetup(root, wizard, payload, ['x64', 'arm64'])
    const bytes = fs.readFileSync(setup)
    const footer = u.footerInfo(bytes)
    assert.equal(u.peInfo(bytes).arch, arch)
    assert.deepEqual(bytes.subarray(footer.wizard, footer.wizard + footer.payload), payloadBytes)
    assert.equal(path.basename(setup), `SidekickAI-Setup-${build.VERSION}-${arch}.exe`)
    const evidence = JSON.parse(fs.readFileSync(path.join(root, `setup-${arch}-evidence.json`)))
    assert.deepEqual(evidence.payloadArchitectures, ['x64', 'arm64'])
    assert.equal(evidence.sha256, u.sha256(setup))
    // A repeated append to the same destination is refused with the stable contract
    // error and must leave the already verified Setup bytes untouched.
    const existing = fs.readFileSync(setup)
    assert.throws(() => build.appendSetup(root, wizard, payload, ['x64', 'arm64']), /Setup destination already exists/)
    assert.deepEqual(fs.readFileSync(setup), existing, 'a refused duplicate must not rewrite the existing Setup')
    setups.push(setup)
  }
  assert.notEqual(...setups)
  assert.throws(() => build.appendSetup(root, path.join(root, 'wizard-arm64.exe'), payload, ['x64']), /architecture/)
  assert.throws(() => build.appendSetup(root, setups[0], payload, ['x64', 'arm64']), /already carries/)
})

test('installation payload staging retains the shared application and adds only architecture-matched uninstallers', t => {
  if (!fs.existsSync(process.env.SIDEKICK_7Z || 'C:\\Program Files\\7-Zip\\7z.exe')) return t.skip('7-Zip is unavailable')
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const output = path.join(root, 'installer')
  const uninstallers = {}
  const inputs = {}
  for (const arch of ['x64', 'arm64']) {
    const directory = application(path.join(applications, build.TARGETS[arch].directory), arch)
    inputs[arch] = build.applicationFingerprint(directory)
    const artifact = path.join(root, `uninstaller-${arch}.exe`)
    fs.writeFileSync(artifact, pe(arch))
    uninstallers[arch] = { artifact, manifest: { protocolVersion: 1, edition: require('../product-edition.json').edition, version: build.VERSION, arch, sha256: u.sha256(artifact), size: fs.statSync(artifact).size, inputFingerprint: 'f'.repeat(64) } }
  }
  const payload = build.buildPayload(output, applications, uninstallers, ['x64', 'arm64'])
  assert.ok(fs.statSync(payload).size > 0)
  const evidence = JSON.parse(fs.readFileSync(path.join(output, 'payload-evidence.json')))
  assert.deepEqual(evidence.applicationInputs, inputs)
  for (const arch of ['x64', 'arm64']) {
    const source = path.join(applications, build.TARGETS[arch].directory)
    const destination = path.join(output, 'payload-staging', build.TARGETS[arch].directory)
    assert.deepEqual(build.applicationFingerprint(source), inputs[arch])
    const staged = build.applicationFingerprint(destination).entries.filter(entry => !['uninstall.exe', 'uninstall-manifest.json'].includes(entry.path))
    assert.deepEqual(staged, inputs[arch].entries)
    assert.equal(fs.existsSync(path.join(destination, 'portable.txt')), false)
    u.verifyArtifact(path.join(destination, 'uninstall.exe'), uninstallers[arch].manifest, arch, build.VERSION)
  }
})

test('cached payload reuse copies the verified bytes and refuses a drifted copy', t => {
  const root = fixture(t)
  const realCache = require('./build-cache.cjs')
  const cached = path.join(root, 'cached-payload.7z')
  const bytes = Buffer.from('verified cached installation payload')
  fs.writeFileSync(cached, bytes)
  const recorded = { path: cached, sha256: u.sha256(cached), size: bytes.length, architectures: ['x64', 'arm64'] }
  let claim = recorded
  const originalLoad = realCache.load
  const originalRemember = realCache.remember
  realCache.load = (name, key) => name === 'payload' ? claim : originalLoad(name, key)
  realCache.remember = (name, key, locations, value) => name === 'payload' ? value : originalRemember(name, key, locations, value)
  t.after(() => {
    realCache.load = originalLoad
    realCache.remember = originalRemember
  })

  const applications = path.join(root, 'applications')
  const uninstallers = {}
  for (const arch of ['x64', 'arm64']) {
    application(path.join(applications, build.TARGETS[arch].directory), arch)
    const artifact = path.join(root, `uninstaller-${arch}.exe`)
    fs.writeFileSync(artifact, pe(arch))
    uninstallers[arch] = { artifact, manifest: { protocolVersion: 1, edition: require('../product-edition.json').edition, version: build.VERSION, arch, sha256: u.sha256(artifact), size: fs.statSync(artifact).size, inputFingerprint: 'f'.repeat(64) } }
  }

  // The cache cannot see the file change, but the delivered copy must still match the
  // record that was verified: a drifted copy is discarded and rebuilt, never shipped.
  const drifted = path.join(root, 'drifted')
  const driftedFile = path.join(root, 'drifted-cache.7z')
  const driftedBytes = Buffer.from('drifted cache bytes')
  fs.writeFileSync(driftedFile, driftedBytes)
  claim = { ...recorded, path: driftedFile }
  const rebuilt = build.buildPayload(drifted, applications, uninstallers, ['x64', 'arm64'], { reuse: true })
  assert.notDeepEqual(fs.readFileSync(rebuilt), driftedBytes, 'a drifted cached copy must not be delivered')
  assert.equal(u.sha256(rebuilt), u.hash(fs.readFileSync(rebuilt)))
  const rebuiltEvidence = JSON.parse(fs.readFileSync(path.join(drifted, 'payload-evidence.json')))
  assert.notEqual(rebuiltEvidence.reused, true, 'a rejected cache entry must not be reported as reused')

  // With the verified bytes restored, the copy is byte-identical and its evidence
  // records the hash of the bytes actually on disk.
  claim = recorded
  const fresh = path.join(root, 'installer-reuse')
  const payload = build.buildPayload(fresh, applications, uninstallers, ['x64', 'arm64'], { reuse: true })
  assert.deepEqual(fs.readFileSync(payload), bytes, 'the reused payload must be byte-identical to the verified cache entry')
  const evidence = JSON.parse(fs.readFileSync(path.join(fresh, 'payload-evidence.json')))
  assert.equal(evidence.reused, true)
  assert.equal(evidence.sha256, u.hash(fs.readFileSync(evidence.path)))
  claim = null
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
