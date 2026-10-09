'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const AdmZip = require('adm-zip')
const payload = require('./application-payload.cjs')
const runtime = require('./application-runtime.cjs')
const application = require('./application-packaging.cjs')
const u = require('./build-utils.cjs')
const { createRuntime, pe } = require('./test-fixtures/application-runtime.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-application-payload-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('standard payloads contain the native runtime at the ZIP root and an unsigned external inventory', async t => {
  const root = fixture(t)
  for (const architecture of ['x64', 'arm64']) {
    const source = await createRuntime(root, architecture)
    const before = application.applicationFingerprint(source)
    const output = path.join(root, 'output')
    const artifact = payload.packApplicationPayload({ source, output, architecture })
    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.kind, 'application-payload')
    assert.equal(manifest.architecture, architecture)
    assert.equal(manifest.productVersion, application.VERSION)
    assert.deepEqual(Object.keys(manifest).sort(), ['architecture', 'archive', 'edition', 'files', 'kind', 'productVersion', 'schemaVersion'])
    assert.throws(() => payload.validateManifest({ ...manifest, signature: 'unverified' }), /manifest fields/)
    assert.throws(() => payload.validateManifest({ ...manifest, files: [...manifest.files, { ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }] }), /Duplicate/)
    assert.throws(() => payload.validateManifest({ ...manifest, files: [...manifest.files, { path: 'resources', size: 0, sha256: u.hash('') }] }), /conflicts with a directory/)
    const zip = new AdmZip(artifact.path)
    const files = zip.getEntries().filter(entry => !entry.isDirectory)
    assert.ok(files.some(entry => entry.entryName === 'SidekickAI.exe'))
    assert.equal(files.length, manifest.files.length)
    for (const file of manifest.files) {
      const bytes = zip.readFile(file.path)
      assert.deepEqual(Object.keys(file), ['path', 'size', 'sha256'])
      assert.equal(bytes.length, file.size)
      assert.equal(u.hash(bytes), file.sha256)
    }
    assert.ok(!files.some(entry => /(?:recover\.exe|uninstall|maintenance|proof\.json|portable\.txt|backup-runtime\.zip)/i.test(entry.entryName)))
    assert.deepEqual(payload.verifyApplicationPayload(artifact.path, manifest), manifest)
    assert.deepEqual(application.applicationFingerprint(source), before)
    assert.throws(() => payload.packApplicationPayload({ source, output, architecture }), /already exists/)
  }
})

test('payload verification rejects archive and file inventory tampering', async t => {
  const root = fixture(t)
  const source = await createRuntime(root, 'x64')
  const artifact = payload.packApplicationPayload({ source, output: path.join(root, 'output'), architecture: 'x64' })
  const original = fs.readFileSync(artifact.path)
  const manifest = structuredClone(artifact.manifest)
  const zip = new AdmZip(artifact.path)
  zip.updateFile('SidekickAI.exe', pe('arm64'))
  zip.writeZip(artifact.path)
  assert.throws(() => payload.verifyApplicationPayload(artifact.path, manifest), /archive identity/)
  manifest.archive.size = fs.statSync(artifact.path).size
  manifest.archive.sha256 = u.sha256(artifact.path)
  assert.throws(() => payload.verifyApplicationPayload(artifact.path, manifest), /checksum/)
  manifest.files = manifest.files.filter(file => file.path !== 'resources/resource-trust.json')
  assert.throws(() => payload.verifyApplicationPayload(artifact.path, manifest), /inventory|checksum/)
  const extraDirectory = new AdmZip(original)
  extraDirectory.addFile('maintenance/', Buffer.alloc(0))
  extraDirectory.writeZip(artifact.path)
  const withDirectory = structuredClone(artifact.manifest)
  withDirectory.archive.size = fs.statSync(artifact.path).size
  withDirectory.archive.sha256 = u.sha256(artifact.path)
  assert.throws(() => payload.verifyApplicationPayload(artifact.path, withDirectory), /outside the file inventory/)
})

test('payload paths reject maintenance attachments, registration state, user data and ambiguous Windows names', () => {
  for (const name of ['recover.exe', 'maintenance/backup-runtime.zip', 'uninstall.exe', 'install-receipt.json',
    'resources/oxy-deployment.json', 'data/settings.json', '../SidekickAI.exe', 'runtime/CON.txt', 'runtime/file. ',
    'portable.txt', 'win-unpacked/SidekickAI.exe', 'SidekickAI/SidekickAI.exe', '.env.local',
    'resources/with?.txt', 'resources/<item>.txt', 'resources/pipe|name.txt',
    'resources/' + '\u6d4b'.repeat(100) + '.txt']) {
    assert.throws(() => payload.validatePayloadPath(name), /non-distributable|Unsafe|user data|normal application/)
  }
})

test('archive verification rejects special entries outside regular files and directories', t => {
  const root = fixture(t)
  const archive = path.join(root, 'special.zip')
  const zip = new AdmZip()
  zip.addFile('runtime.txt', Buffer.from('fixture'))
  zip.writeZip(archive)
  const original = fs.readFileSync(archive)
  for (const mode of [0o010644, 0o020644, 0o060644, 0o120644, 0o140644]) {
    const bytes = Buffer.from(original)
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt16LE((3 << 8) | 20, central + 4)
    bytes.writeUInt32LE((mode * 65536) >>> 0, central + 38)
    fs.writeFileSync(archive, bytes)
    assert.throws(() => runtime.verifyArchive(archive), /Nonregular/)
  }
})

test('payload packaging rejects mixed native code and portable sources before producing an archive', async t => {
  const root = fixture(t)
  const source = await createRuntime(root, 'x64')
  const output = path.join(root, 'output')
  assert.throws(() => payload.packApplicationPayload({ source, output: source, architecture: 'x64' }), /outside/)
  assert.throws(() => payload.packApplicationPayload({ source, output, architecture: 'arm64' }), /architecture/)
  fs.writeFileSync(path.join(source, 'ffmpeg.dll'), pe('arm64'))
  assert.throws(() => payload.packApplicationPayload({ source, output, architecture: 'x64' }), /architecture/)
  fs.writeFileSync(path.join(source, 'ffmpeg.dll'), pe('x64'))
  fs.writeFileSync(path.join(source, 'portable.txt'), 'marker')
  assert.throws(() => payload.packApplicationPayload({ source, output, architecture: 'x64' }), /portable/)
  assert.equal(fs.existsSync(output), false)
})

test('application configuration works without private credentials or configured public trust', t => {
  assert.deepEqual(runtime.applicationConfiguration(fixture(t), {}), { origin: '', keys: [], resourceKeys: [] })
})
