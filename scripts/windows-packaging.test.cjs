'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const build = require('./application-packaging.cjs')
const portable = require('./pack-portable.cjs')
const { createRuntime } = require('./test-fixtures/application-runtime.cjs')
const u = require('./build-utils.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-windows-package-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('each green archive carries one native runtime without recovery, installation state or official proofs', async t => {
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const before = {}
  for (const arch of ['x64', 'arm64']) before[arch] = build.applicationFingerprint(await createRuntime(applications, arch))
  const output = path.join(root, 'green')
  const artifacts = portable.packPortable({ output, applications, minimumZipBytes: 1 })
  assert.deepEqual(artifacts.map(artifact => artifact.arch), ['x64', 'arm64'])
  for (const artifact of artifacts) {
    const arch = artifact.arch
    assert.equal(path.basename(artifact.path), `SidekickAI-Portable-${build.VERSION}-${arch}-win.zip`)
    const zip = new AdmZip(artifact.path)
    const names = zip.getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName)
    assert.ok(names.includes('SidekickAI/SidekickAI.exe'))
    assert.ok(names.includes('SidekickAI/resources/app.asar'))
    const marker = zip.readFile('SidekickAI/portable.txt').toString('utf8')
    assert.equal(marker.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0], 'AI Window Portable Mode Marker')
    // 单架构包内只有本架构运行目录，不再有并列目录、启动器或布局契约文件
    assert.ok(!names.some(name => name.startsWith('SidekickAI/' + build.TARGETS[arch].directory + '/')))
    assert.ok(!names.some(name => /(?:recover\.exe|uninstall|maintenance|proof\.json|backup-runtime\.zip|install-receipt|Start-SidekickAI\.cmd|portable-layout\.json)/i.test(name)))
    assert.ok(!names.some(name => /^SidekickAI\/data\/.+/.test(name)))
    const manifest = JSON.parse(zip.readFile('SidekickAI/portable-manifest.json').toString())
    assert.deepEqual(manifest.architectures, [arch])
    for (const file of manifest.files) {
      const bytes = zip.readFile('SidekickAI/' + file.path)
      assert.equal(bytes.length, file.size)
      assert.equal(u.hash(bytes), file.sha256)
    }
    assert.deepEqual(names.filter(name => !name.endsWith('/portable-manifest.json')).map(name => name.slice('SidekickAI/'.length)).sort(), manifest.files.map(file => file.path).sort())
    assert.deepEqual(build.applicationFingerprint(path.join(applications, build.TARGETS[arch].directory)), before[arch])
  }
  assert.throws(() => portable.packPortable({ output, applications, minimumZipBytes: 1 }), /already exists/)
})

test('portable packaging can produce a single architecture archive on demand', async t => {
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  await createRuntime(applications, 'x64')
  const output = path.join(root, 'green')
  const artifacts = portable.packPortable({ output, applications, architectures: ['x64'], minimumZipBytes: 1 })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].arch, 'x64')
  assert.equal(path.basename(artifacts[0].path), `SidekickAI-Portable-${build.VERSION}-x64-win.zip`)
  const names = new AdmZip(artifacts[0].path).getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName)
  assert.ok(names.includes('SidekickAI/SidekickAI.exe'))
})

test('portable paths reject configuration secrets, maintenance tools and runtime user data', () => {
  for (const name of ['resources/oxy-deployment.json', 'oxy-service.json', 'data/chat.db', 'maintenance/uninstall.exe',
    'recover.exe', 'backup-runtime.zip', 'distribution-proof.json', 'install-receipt.json', '.env.local']) {
    assert.throws(() => portable.validatePortablePath(name), /non-distributable|user data/)
  }
  assert.equal(portable.validatePortablePath('resources/oxy-service.json'), 'resources/oxy-service.json')
})

test('Windows architectures reject duplicates and unsupported values', () => {
  for (const values of [[], ['x64', 'x64'], ['ia32'], 'arm64']) assert.throws(() => build.validateArchitectures(values), /architectures/)
  assert.deepEqual(build.validateArchitectures(['arm64']), ['arm64'])
})
