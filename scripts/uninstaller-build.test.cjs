'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const u = require('./uninstaller-build-utils.cjs')
const build = require('./build-tauri-installer.cjs')

function pe(arch = 'x64', content = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(1024)
  bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128)
  bytes.writeUInt16LE(u.MACHINES[arch], 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt32LE(512, 212)
  bytes.writeUInt32LE(512, 408); bytes.writeUInt32LE(512, 412)
  content.copy(bytes, 512)
  return bytes
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-uninstaller-build-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function executable(dir, bytes = pe()) {
  const file = path.join(dir, 'uninstall.exe'); fs.writeFileSync(file, bytes); return file
}
function manifest(file, arch = 'x64') {
  return { protocolVersion: 1, edition: require('../product-edition.json').edition, version: '0.1.0-alpha', arch, sha256: u.sha256(file), size: fs.statSync(file).size, inputFingerprint: 'a'.repeat(64) }
}

test('PE checks both exact architectures and rejects corrupt/truncated sections', t => {
  const dir = fixture(t)
  const file = executable(dir)
  assert.equal(u.assertStandaloneBinary(file, 'x64').arch, 'x64')
  assert.throws(() => u.assertStandaloneBinary(file, 'arm64'), /ARCH_MISMATCH/)
  fs.writeFileSync(file, pe('arm64')); assert.equal(u.assertStandaloneBinary(file, 'arm64').arch, 'arm64')
  assert.throws(() => u.peInfo(Buffer.from('MZ')), /DOS/)
  const bytes = pe(); bytes.writeUInt32LE(9000, 412)
  assert.throws(() => u.peInfo(bytes), /outside/)
})

test('identity app.asar path strings are allowed, archive bytes are rejected', t => {
  const dir = fixture(t)
  const file = executable(dir, pe('x64', Buffer.from('resources\\app.asar resources/app.asar SKPAYLD1')))
  assert.doesNotThrow(() => u.assertStandaloneBinary(file, 'x64'))
  const json = Buffer.from('{"files":{"main.js":{"size":4,"offset":"0"}}}')
  const asar = Buffer.alloc(16 + json.length + 4)
  asar.writeUInt32LE(4, 0); asar.writeUInt32LE(json.length + 8, 4)
  asar.writeUInt32LE(json.length + 4, 8); asar.writeUInt32LE(json.length, 12); json.copy(asar, 16)
  fs.writeFileSync(file, pe('x64', asar))
  assert.throws(() => u.assertStandaloneBinary(file), /archive/)
  fs.writeFileSync(file, pe('x64', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])))
  assert.throws(() => u.assertStandaloneBinary(file), /archive/)
})

test('actual Setup footer, payload dependencies, and unexplained overlay fail', t => {
  const dir = fixture(t)
  const tail = Buffer.alloc(28); tail.write('SKPAYLD1'); tail.writeBigUInt64LE(10n, 8); tail.writeBigUInt64LE(10n, 16); tail.writeUInt32LE(28, 24)
  const file = executable(dir, Buffer.concat([pe(), Buffer.alloc(20), tail]))
  assert.deepEqual(u.footerInfo(fs.readFileSync(file)), { wizard: 1024, payload: 10, sevenz: 10, footer: 28 })
  assert.throws(() => u.assertStandaloneBinary(file), /footer/)
  for (const bytes of [Buffer.from('payload.7z'), Buffer.from('7zr.exe', 'utf16le')]) {
    fs.writeFileSync(file, pe('x64', bytes)); assert.throws(() => u.assertStandaloneBinary(file), /dependency/)
  }
  fs.writeFileSync(file, Buffer.concat([pe(), Buffer.from('junk')]))
  assert.throws(() => u.assertStandaloneBinary(file), /overlay/)
})

test('fingerprints detect changed bytes despite restored timestamps and directory mtime', t => {
  const dir = fixture(t); const file = path.join(dir, 'input.rs'); fs.writeFileSync(file, 'one')
  const stat = fs.statSync(file); const before = u.fingerprint(dir, [dir])
  assert.doesNotThrow(() => u.assertUnchanged(before, u.fingerprint(dir, [dir])))
  fs.writeFileSync(file, 'two'); fs.utimesSync(file, stat.atime, stat.mtime)
  assert.throws(() => u.assertUnchanged(before, u.fingerprint(dir, [dir])), /inputs changed/)
})

test('artifact metadata binds architecture/version/protocol/size/hash and current bytes', t => {
  const dir = fixture(t); const file = executable(dir); const meta = manifest(file)
  assert.doesNotThrow(() => u.verifyArtifact(file, meta, 'x64', meta.version))
  for (const change of [{ edition: 'foreign' }, { protocolVersion: 2 }, { version: 'old' }, { arch: 'arm64' }, { size: 4 }, { sha256: 'b'.repeat(64) }, { inputFingerprint: 'missing' }]) {
    assert.throws(() => u.verifyArtifact(file, { ...meta, ...change }, 'x64', meta.version), /manifest/)
  }
  fs.writeFileSync(file, pe('x64', Buffer.from('changed')))
  assert.throws(() => u.verifyArtifact(file, meta, 'x64', meta.version), /manifest/)
})

test('staging updates only explicit copy and retains existing package bytes', t => {
  const dir = fixture(t); const source = path.join(dir, 'source'); const stage = path.join(dir, 'stage')
  fs.mkdirSync(source); fs.mkdirSync(stage)
  const file = executable(source); const meta = manifest(file)
  const old = path.join(dir, 'old-setup.exe'); fs.writeFileSync(old, 'preserve')
  u.stageUninstaller(file, meta, stage, 'x64', meta.version)
  assert.equal(u.sha256(path.join(stage, 'uninstall.exe')), meta.sha256)
  assert.equal(fs.readFileSync(old, 'utf8'), 'preserve')
  assert.equal(u.sha256(file), meta.sha256)
  assert.notEqual(u.uniqueOutput(dir), u.uniqueOutput(dir))
})

test('dependency evidence rejects installer engine but permits shared core and identity paths', t => {
  const dir = fixture(t); const file = path.join(dir, 'standalone.d')
  fs.writeFileSync(file, 'exe: installer-shared/uninstall-core/src/scan.rs resources/app.asar')
  assert.doesNotThrow(() => u.assertDependencyBoundary(file))
  fs.writeFileSync(file, 'exe: E:/root/installer-tauri/src-tauri/src/engine.rs')
  assert.throws(() => u.assertDependencyBoundary(file), /links installer/)
})

test('command failures and missing dependencies fail explicitly without shell fallback', t => {
  assert.throws(() => build.run(process.execPath, ['-e', 'process.exit(23)'], 'fixture'), /exit 23/)
  assert.throws(() => build.run('sidekick-nonexistent-test-command', [], 'fixture'), /ENOENT/)
  const previous = process.env.SIDEKICK_TAURI_NODE_MODULES
  process.env.SIDEKICK_TAURI_NODE_MODULES = fixture(t)
  try { assert.throws(() => build.tools(), /ENOENT/) } finally {
    if (previous === undefined) delete process.env.SIDEKICK_TAURI_NODE_MODULES
    else process.env.SIDEKICK_TAURI_NODE_MODULES = previous
  }
})

test('shared native and operation UI sources are release inputs for both hosts', () => {
  const relative = inputs => inputs.map(file => path.relative(build.ROOT, file).replaceAll('\\', '/'))
  for (const app of [build.INSTALLER, build.UNINSTALLER]) {
    const inputs = relative(build.sourceInputs(app))
    for (const file of ['installer-shared/operation-details', 'installer-shared/uninstall-core/build.rs', 'installer-shared/uninstall-host/build.rs']) {
      assert.ok(inputs.some(input => input === file || input.startsWith(file + '/')), `${file} must be a release input for ${path.basename(app)}`)
    }
  }
})

test('the native packaging path waits for a delayed plugin build and stops on failure', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const delayed = {
    async buildPlugins() { calls.push('plugins:start'); await gate; calls.push('plugins:end'); return {} },
    buildApplications() { calls.push('application'); return 'shared-application' },
    buildInstallerArtifacts(output, applications) { calls.push('installers'); return { applications } },
  }
  const building = build.buildProducts('output', ['x64'], {}, delayed)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['plugins:start'], 'the application packaging must not start while plugins are still building')
  release()
  await building
  assert.deepEqual(calls, ['plugins:start', 'plugins:end', 'application', 'installers'])

  const failing = {
    async buildPlugins() { calls.push('failed-plugins'); throw new Error('plugin bundling failed') },
    buildApplications() { calls.push('failed-application'); return 'shared-application' },
    buildInstallerArtifacts() { calls.push('failed-installers'); return {} },
  }
  await assert.rejects(() => build.buildProducts('output', ['x64'], {}, failing), /plugin bundling failed/)
  assert.deepEqual(calls.slice(-1), ['failed-plugins'], 'a rejected plugin build must stop the native packaging path')
})

test('native identity captures esbuild/rollup CLI versions and their native binary bytes', t => {
  const root = fixture(t)
  const write = (relative, contents) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  write('package.json', '{}\n')
  write('node_modules/esbuild/package.json', JSON.stringify({ name: 'esbuild', version: '0.21.5', optionalDependencies: { '@esbuild/win32-x64': '0.21.5', '@esbuild/linux-x64': '0.21.5' } }))
  write('node_modules/@esbuild/win32-x64/package.json', JSON.stringify({ name: '@esbuild/win32-x64', version: '0.21.5' }))
  write('node_modules/@esbuild/win32-x64/esbuild.exe', 'native-binary-one')
  write('node_modules/rollup/package.json', JSON.stringify({ name: 'rollup', version: '4.62.2', optionalDependencies: { '@rollup/rollup-win32-x64-msvc': '4.62.2', fsevents: '2.3.3' } }))
  write('node_modules/@rollup/rollup-win32-x64-msvc/package.json', JSON.stringify({ name: '@rollup/rollup-win32-x64-msvc', version: '4.62.2' }))
  write('node_modules/@rollup/rollup-win32-x64-msvc/rollup.node', 'native-binary-one')

  const first = build.dependencyToolIdentity(root)
  assert.equal(first.esbuild.version, '0.21.5')
  assert.equal(first.esbuild.platforms['@esbuild/win32-x64'], '0.21.5')
  assert.equal(first.rollup.version, '4.62.2')
  assert.equal(first.rollup.platforms['@rollup/rollup-win32-x64-msvc'], '4.62.2')
  assert.equal(first.esbuild.platforms.fsevents, undefined, 'unrelated optional dependencies are not part of the tool identity')
  assert.match(first.esbuild.fingerprint, /^[a-f0-9]{64}$/)

  write('node_modules/@esbuild/win32-x64/esbuild.exe', 'native-binary-two')
  const second = build.dependencyToolIdentity(root)
  assert.notEqual(second.esbuild.fingerprint, first.esbuild.fingerprint, 'changed native tool bytes must move the identity')
  assert.equal(second.rollup.fingerprint, first.rollup.fingerprint)

  fs.rmSync(path.join(root, 'node_modules', 'rollup'), { recursive: true, force: true })
  assert.ok(build.dependencyToolIdentity(root).rollup.unresolved, 'a missing tool is reported instead of thrown')
})
