'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const yauzl = require('yauzl')
const toolkit = require('./distribution-toolkit.cjs')
const u = require('./build-utils.cjs')
const { pe } = require('./test-fixtures/application-runtime.cjs')
const { fixtureRoot, toolkitFixture, writeToolkit } = require('./test-fixtures/distribution-toolkit.cjs')

function pinnedReference() {
  return structuredClone(require('../maintenance/distribution-toolkit.json'))
}

const foreignIdentities = [
  ['version', value => { value.toolkitVersion += '-foreign' }, /version.*trusted release/i],
  ['size', value => { value.archive.size++ }, /size.*trusted release/i],
  ['digest', value => { value.archive.sha256 = '0'.repeat(64) }, /SHA-256.*trusted release/i],
]

test('production references reject each foreign release identity', () => {
  const reference = pinnedReference()
  assert.equal(toolkit.validateReference(reference), reference)
  for (const [name, change, expected] of foreignIdentities) {
    const foreign = structuredClone(reference)
    change(foreign)
    assert.throws(() => toolkit.validateReference(foreign), expected, name)
  }
})

test('production acquisition rejects foreign identities before archive access or cache creation', async t => {
  for (const selection of ['default', 'environment', 'direct']) {
    for (const [name, change, expected] of foreignIdentities) await t.test(selection + ':' + name, async sub => {
      const root = fixtureRoot(sub)
      const reference = pinnedReference()
      reference.archive.path = 'vendor/distribution/unread.zip'
      change(reference)
      const referenceFile = path.join(root, selection === 'default' ? 'maintenance/distribution-toolkit.json' : 'reference.json')
      fs.mkdirSync(path.dirname(referenceFile), { recursive: true })
      fs.writeFileSync(referenceFile, JSON.stringify(reference))
      const previous = process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
      if (selection === 'environment') process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE = referenceFile
      else delete process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
      sub.after(() => {
        if (previous === undefined) delete process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
        else process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE = previous
      })
      const archivePath = path.join(root, reference.archive.path)
      const read = fs.readFileSync
      sub.mock.method(fs, 'readFileSync', (file, ...args) => {
        assert.notEqual(path.resolve(file), archivePath, 'Foreign references must not read archive bytes')
        return read(file, ...args)
      })
      sub.mock.method(u, 'sha256', () => assert.fail('Foreign references must not hash archive bytes'))
      sub.mock.method(fs, 'createReadStream', () => assert.fail('Foreign references must not stream archive bytes'))
      sub.mock.method(yauzl, 'openPromise', () => assert.fail('Foreign references must not open ZIP entries'))
      const options = { fetch() { assert.fail('Foreign references must not download archive bytes') } }
      if (selection === 'direct') options.reference = reference
      await assert.rejects(toolkit.prepareToolkit(root, options), expected)
      assert.equal(fs.existsSync(path.join(root, 'build')), false)
    })
  }
})

async function localServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return 'http://127.0.0.1:' + server.address().port
}

test('toolkit references pin the protocol, version, size, digest and explicit source', () => {
  const reference = pinnedReference()
  assert.equal(toolkit.validateReference(reference), reference)
  const https = structuredClone(reference)
  delete https.archive.path
  https.archive.url = 'https://example.invalid/downloads/toolkit.zip?version=1.3.1'
  assert.equal(toolkit.validateReference(https), https)
  for (const [name, change] of [
    ['protocol', value => { value.interfaceVersion = 2 }],
    ['version suffix', value => { value.toolkitVersion += '\n' }],
    ['version leading zero', value => { value.toolkitVersion = '01.2.0' }],
    ['missing pin', value => { delete value.archive.sha256 }],
    ['zero size', value => { value.archive.size = 0 }],
    ['fractional size', value => { value.archive.size = 1.5 }],
    ['oversized archive', value => { value.archive.size = toolkit.MAX_ARCHIVE_BYTES + 1 }],
    ['uppercase digest', value => { value.archive.sha256 = 'A'.repeat(64) }],
    ['unknown property', value => { value.downloadLatest = true }],
  ]) {
    const value = structuredClone(reference)
    change(value)
    assert.throws(() => toolkit.validateReference(value), undefined, name)
  }
  for (const url of ['http://example.invalid/toolkit.zip', 'ftp://example.invalid/toolkit.zip',
    'https://user:password@example.invalid/toolkit.zip', 'https://example.invalid/toolkit.zip#fragment',
    'file://server/share/toolkit.zip', './toolkit.zip']) {
    const value = structuredClone(https)
    value.archive.url = url
    assert.throws(() => toolkit.validateReference(value, { allowLoopback: true }), undefined, url)
  }
  const loopback = structuredClone(https)
  loopback.archive.url = 'http://127.0.0.1:12345/toolkit.zip'
  assert.throws(() => toolkit.validateReference(loopback), /HTTPS/)
  assert.equal(toolkit.validateReference(loopback, { allowLoopback: true }), loopback)
})

test('toolkit reference selection has no implicit sibling workspace fallback', t => {
  const root = fixtureRoot(t)
  const reference = pinnedReference()
  assert.throws(() => toolkit.readReference(root, { env: {} }), /SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE/)
  const referenceFile = path.join(root, 'selected-reference.json')
  fs.writeFileSync(referenceFile, JSON.stringify(reference))
  const selected = { file: referenceFile, reference, sha256: u.sha256(referenceFile) }
  assert.deepEqual(toolkit.readReference(root, { referenceFile }), selected)
  assert.deepEqual(toolkit.readReference(root, { env: { SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE: referenceFile } }),
    selected)
  fs.writeFileSync(referenceFile, ' '.repeat(toolkit.MAX_MANIFEST_BYTES + 1))
  assert.throws(() => toolkit.readReference(root, { referenceFile }), /size limit/)
})

test('the default project pin resolves its archive within the workspace', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'vendor/distribution'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  delete reference.archive.url
  reference.archive.path = path.relative(root, published.archive).replaceAll('\\', '/')
  fs.mkdirSync(path.join(root, 'maintenance'))
  fs.writeFileSync(path.join(root, 'maintenance/distribution-toolkit.json'), JSON.stringify(reference))
  const prepared = await toolkit.prepareToolkit(root)
  assert.deepEqual(prepared.reference, reference)
  assert.equal(prepared.referenceFile, path.join(root, 'maintenance/distribution-toolkit.json'))
  assert.equal(prepared.manifest.toolkitVersion, reference.toolkitVersion)
  assert.equal((await toolkit.prepareToolkit(root)).reused, true)
  for (const archivePath of ['../toolkit.zip', 'C:/toolkit.zip', '/toolkit.zip', 'vendor\\toolkit.zip', 'vendor/../toolkit.zip']) {
    assert.throws(() => toolkit.validateReference({ ...reference, archive: { ...reference.archive, path: archivePath } }), undefined, archivePath)
  }
  assert.throws(() => toolkit.validateReference({ ...reference, archive: { ...reference.archive, url: published.reference.archive.url } }), /exactly one/)
  const withoutLocation = structuredClone(reference)
  delete withoutLocation.archive.path
  assert.throws(() => toolkit.validateReference(withoutLocation), /exactly one/)
})

test('project pins fail when their local archive is absent or linked outside the project', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'outside'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  delete reference.archive.url
  reference.archive.path = 'vendor/distribution/toolkit.zip'
  await assert.rejects(toolkit.prepareToolkit(root, { reference }), /file|ENOENT/i)
  fs.mkdirSync(path.join(root, 'vendor'))
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'vendor/distribution'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(toolkit.prepareToolkit(root, { reference }), /filesystem links/)
})

test('warm project caches still require the original archive bytes and an unlinked source', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'vendor/distribution'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  delete reference.archive.url
  reference.archive.path = path.relative(root, published.archive).replaceAll('\\', '/')
  const bytes = fs.readFileSync(published.archive)
  const prepared = await toolkit.prepareToolkit(root, { reference })
  const mutations = [
    () => fs.appendFileSync(published.archive, 'damaged'),
    () => fs.unlinkSync(published.archive),
    () => fs.writeFileSync(published.archive, 'version https://git-lfs.github.com/spec/v1\noid sha256:' + reference.archive.sha256 + '\nsize ' + reference.archive.size + '\n'),
  ]
  for (const mutate of mutations) {
    mutate()
    assert.throws(() => toolkit.assertUnchanged(prepared))
    await assert.rejects(toolkit.prepareToolkit(root, { reference }))
    fs.writeFileSync(published.archive, bytes)
    toolkit.assertUnchanged(prepared)
  }
  const original = path.join(root, 'vendor/distribution')
  const moved = path.join(root, 'retained')
  fs.renameSync(original, moved)
  fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => toolkit.assertUnchanged(prepared), /filesystem links/)
  await assert.rejects(toolkit.prepareToolkit(root, { reference }), /filesystem links/)
})

test('a real loopback download verifies a complete toolkit and reuses a rechecked cache', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const bytes = fs.readFileSync(published.archive)
  let requests = 0
  const origin = await localServer(t, (request, response) => {
    requests++
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length })
    response.end(bytes)
  })
  const reference = structuredClone(published.reference)
  reference.archive.url = origin + '/toolkit.zip'
  const options = { reference, allowLoopback: true }
  const first = await toolkit.prepareToolkit(path.join(root, 'workspace'), options)
  assert.equal(first.reused, false)
  assert.equal(first.manifest.toolkitVersion, '1.2.0')
  assert.deepEqual(first.manifest.files, published.manifest.files)
  assert.equal(first.directory, path.join(root, 'workspace/build/component-cache/distribution-toolkit', reference.archive.sha256, 'toolkit'))
  const second = await toolkit.prepareToolkit(path.join(root, 'workspace'), {
    ...options, fetch() { throw new Error('A valid cache must not download again') },
  })
  assert.equal(second.reused, true)
  assert.deepEqual(first.inputs, second.inputs)
  assert.equal(requests, 1)
  toolkit.assertUnchanged(first)
})

test('download errors and pin mismatches never promote an unverified cache entry', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const bytes = fs.readFileSync(published.archive)
  const origin = await localServer(t, (request, response) => {
    if (request.url === '/failed') { response.writeHead(503); response.end('unavailable'); return }
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/archive' }); response.end(); return }
    const changed = Buffer.from(bytes)
    changed[0] ^= 1
    response.end(request.url === '/short' ? bytes.subarray(0, bytes.length - 1)
      : request.url === '/changed' ? changed
      : request.url === '/long' ? Buffer.concat([bytes, Buffer.from('extra')]) : bytes)
  })
  for (const [name, route, expected] of [
    ['http-error', '/failed', /HTTP 503/],
    ['truncated', '/short', /pinned size and SHA-256/],
    ['excess', '/long', /exceeds its declared size/],
    ['digest', '/changed', /pinned size and SHA-256/],
  ]) await t.test(name, async () => {
    const reference = structuredClone(published.reference)
    reference.archive.url = origin + route
    const workspace = path.join(root, name)
    await assert.rejects(toolkit.prepareToolkit(workspace, { reference, allowLoopback: true }), expected)
    assert.equal(fs.existsSync(path.join(workspace, 'build/component-cache/distribution-toolkit', reference.archive.sha256)), false)
  })
  const redirected = structuredClone(published.reference)
  redirected.archive.url = origin + '/redirect'
  assert.equal((await toolkit.prepareToolkit(path.join(root, 'redirected'), { reference: redirected, allowLoopback: true })).reused, false)
})

test('download responses cannot change an HTTPS reference to an unapproved transport', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  reference.archive.url = 'https://example.invalid/toolkit.zip'
  await assert.rejects(toolkit.prepareToolkit(path.join(root, 'workspace'), {
    reference,
    fetch: async () => {
      const response = new Response(fs.readFileSync(published.archive))
      Object.defineProperty(response, 'url', { value: 'http://example.invalid/toolkit.zip' })
      return response
    },
  }), /HTTPS/)
})

test('toolkit capabilities must include both self-built concept architectures', () => {
  const base = toolkitFixture().manifest
  const reference = { toolkitVersion: base.toolkitVersion }
  assert.equal(toolkit.validateManifest(base, reference), base)
  for (const change of [
    value => { value.toolkitVersion = '1.2.1' },
    value => { value.host.platform = 'linux' },
    value => { value.capabilities[0].authority = 'official' },
    value => { value.capabilities[0].edition = 'community' },
    value => { value.capabilities[0].mode = 'online' },
    value => { value.capabilities[0].architectures = ['x64'] },
    value => { value.capabilities[0].architectures = ['x64', 'x64'] },
    value => { value.capabilities.push(structuredClone(value.capabilities[0])) },
    value => { value.assembler = 'bin/other.exe' },
    value => { value.files[0].architecture = 'arm64' },
    value => { value.files.push({ ...value.files[0], path: 'bin/second.exe' }) },
  ]) {
    const manifest = structuredClone(base)
    change(manifest)
    assert.throws(() => toolkit.validateManifest(manifest, reference))
  }
})

test('toolkit placeholder trust must be a canonical public Ed25519 identity bound to its key', () => {
  const base = toolkitFixture().manifest
  const reference = { toolkitVersion: base.toolkitVersion }
  assert.equal(toolkit.validateManifest(base, reference), base)
  for (const change of [
    value => { delete value.placeholderTrust },
    value => { value.placeholderTrust.id = 'self-built-' + '0'.repeat(64) },
    value => { value.placeholderTrust.publicKey.kty = 'RSA' },
    value => { value.placeholderTrust.publicKey.crv = 'X25519' },
    value => { value.placeholderTrust.publicKey.x = 'A'.repeat(42) + 'B' },
    value => { value.placeholderTrust.publicKey.d = 'private-key-material' },
  ]) {
    const manifest = structuredClone(base)
    change(manifest)
    assert.throws(() => toolkit.validateManifest(manifest, reference))
  }
})

test('a toolkit must contain every required component role for its advertised capability', async t => {
  const base = toolkitFixture().manifest
  const reference = { toolkitVersion: base.toolkitVersion }
  for (const file of base.files) await t.test(file.role + ':' + (file.architecture || 'shared'), () => {
    const manifest = structuredClone(base)
    manifest.files = manifest.files.filter(item => item.path !== file.path)
    assert.throws(() => toolkit.validateManifest(manifest, reference), /assembler|component|contract|license|role/i)
  })
  for (const property of ['edition', 'authority']) {
    const manifest = structuredClone(base)
    manifest.files.find(file => file.role === 'wizard-template' && file.architecture === 'arm64')[property] =
      property === 'edition' ? 'community' : 'official'
    assert.throws(() => toolkit.validateManifest(manifest, reference), /missing/)
  }
})

test('toolkit inventories reject ambiguous paths, file-directory collisions and unbounded metadata', () => {
  const base = toolkitFixture().manifest
  for (const name of ['../escape.exe', '/absolute.exe', 'C:/absolute.exe', 'bin\\escape.exe',
    'bin/CON.exe', 'bin/trailing. ', 'bin/with?.exe', 'toolkit-manifest.json']) {
    const manifest = structuredClone(base)
    manifest.files.push({ ...manifest.files.at(-1), path: name })
    assert.throws(() => toolkit.validateManifest(manifest, { toolkitVersion: base.toolkitVersion }), undefined, name)
  }
  for (const change of [
    value => { value.files.push({ ...value.files.at(-1), path: 'license.TXT' }) },
    value => { value.files.push({ ...value.files.at(-1), path: 'bin' }) },
    value => { value.files[0].size = 0 },
    value => { value.files[0].size = toolkit.MAX_ARCHIVE_BYTES + 1 },
    value => { value.files[0].sha256 = 'not-a-digest' },
    value => { value.files[0].role = 'final-setup' },
    value => { value.files[0].secret = true },
  ]) {
    const manifest = structuredClone(base)
    change(manifest)
    assert.throws(() => toolkit.validateManifest(manifest, { toolkitVersion: base.toolkitVersion }))
  }
})

test('real toolkit ZIP parsing rejects missing, duplicate, unsafe, extra and special entries', async t => {
  for (const [name, change] of [
    ['missing-manifest', value => { value.manifest = null }],
    ['duplicate-manifest', value => { value.entries.push({ name: 'toolkit-manifest.json', bytes: Buffer.from('{}') }) }],
    ['duplicate-file', value => { value.entries.push({ ...value.entries[0] }) }],
    ['case-collision', value => { value.entries.push({ name: 'license.txt', bytes: Buffer.from('extra') }) }],
    ['extra-file', value => { value.entries.push({ name: 'unlisted.txt', bytes: Buffer.from('extra') }) }],
    ['extra-directory', value => { value.entries.push({ name: 'unlisted/', bytes: Buffer.alloc(0) }) }],
    ['missing-file', value => { value.entries.pop() }],
    ['wrong-content', value => { value.entries.at(-1).bytes = Buffer.from('Changed license notice\n') }],
    ['traversal', value => { value.entries.push({ name: '../outside.txt', bytes: Buffer.from('extra') }) }],
    ['absolute', value => { value.entries.push({ name: '/outside.txt', bytes: Buffer.from('extra') }) }],
    ['backslash', value => { value.entries.push({ name: 'bin\\outside.txt', bytes: Buffer.from('extra') }) }],
    ['oversized-manifest', value => { value.manifest.extra = 'x'.repeat(toolkit.MAX_MANIFEST_BYTES) }],
    ...[0o010644, 0o020644, 0o060644, 0o120644, 0o140644].map(mode =>
      ['special-' + mode.toString(8), value => { value.entries[0].mode = mode }]),
  ]) await t.test(name, async sub => {
    const root = fixtureRoot(sub)
    const fixture = toolkitFixture()
    change(fixture)
    const published = writeToolkit(path.join(root, 'published'), fixture)
    const toolkit = published.toolkit
    await assert.rejects(toolkit.prepareToolkit(path.join(root, 'workspace'), { reference: published.reference }))
    assert.equal(fs.existsSync(path.join(root, 'workspace/build/component-cache/distribution-toolkit', published.reference.archive.sha256)), false)
    assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false)
  })
})

test('matching archive hashes cannot conceal an executable architecture mismatch', async t => {
  const root = fixtureRoot(t)
  const fixture = toolkitFixture()
  const entry = fixture.entries.find(item => item.name.endsWith('x64/uninstaller-template.exe'))
  const file = fixture.manifest.files.find(item => item.path === entry.name)
  entry.bytes = pe('arm64')
  file.size = entry.bytes.length
  file.sha256 = u.hash(entry.bytes)
  const published = writeToolkit(path.join(root, 'published'), fixture)
  const toolkit = published.toolkit
  await assert.rejects(toolkit.prepareToolkit(path.join(root, 'workspace'), { reference: published.reference }), /native architecture/)
})

test('toolkit native libraries must match the architecture advertised for their exact bytes', async t => {
  for (const extension of ['dll', 'node']) await t.test(extension, async sub => {
    const root = fixtureRoot(sub)
    const fixture = toolkitFixture()
    const name = 'runtime/x64/native-library.' + extension
    const bytes = pe('arm64')
    fixture.entries.push({ name, bytes })
    fixture.manifest.files.push({ path: name, role: 'backup-runtime', architecture: 'x64',
      size: bytes.length, sha256: u.hash(bytes) })
    const published = writeToolkit(path.join(root, 'published'), fixture)
    const toolkit = published.toolkit
    await assert.rejects(toolkit.prepareToolkit(path.join(root, 'workspace'), { reference: published.reference }), /native architecture/)
  })
})

test('cached archives and extracted resources are revalidated before reuse', async t => {
  for (const [name, change] of [
    ['archive-bytes', value => fs.appendFileSync(value.archive, 'changed')],
    ['resource-bytes', value => fs.appendFileSync(path.join(value.directory, 'LICENSE.txt'), 'changed')],
    ['extra-resource', value => fs.writeFileSync(path.join(value.directory, 'extra.txt'), 'unlisted')],
    ['missing-resource', value => fs.unlinkSync(path.join(value.directory, 'LICENSE.txt'))],
    ['non-file-resource', value => {
      fs.unlinkSync(path.join(value.directory, 'LICENSE.txt'))
      fs.mkdirSync(path.join(value.directory, 'LICENSE.txt'))
    }],
    ['linked-root', value => {
      fs.renameSync(value.directory, value.directory + '-original')
      fs.symlinkSync(value.directory + '-original', value.directory, 'junction')
    }],
  ]) await t.test(name, async sub => {
    const root = fixtureRoot(sub)
    const published = writeToolkit(path.join(root, 'published'))
    const toolkit = published.toolkit
    const workspace = path.join(root, 'workspace')
    const prepared = await toolkit.prepareToolkit(workspace, { reference: published.reference })
    change(prepared)
    await assert.rejects(toolkit.prepareToolkit(workspace, { reference: published.reference }))
    assert.throws(() => toolkit.assertUnchanged(prepared))
  })
})

test('a selected reference file cannot change between preparation and binary invocation', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const referenceFile = path.join(root, 'selected-reference.json')
  fs.writeFileSync(referenceFile, JSON.stringify(published.reference))
  const prepared = await toolkit.prepareToolkit(path.join(root, 'workspace'), { referenceFile })
  toolkit.assertUnchanged(prepared)
  fs.appendFileSync(referenceFile, '\n')
  assert.throws(() => toolkit.assertUnchanged(prepared), /reference|changed/i)
})

test('cache promotion waits until all archive reader handles have closed', async t => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const open = yauzl.openPromise
  const rename = fs.renameSync
  const readers = new Set()
  t.mock.method(yauzl, 'openPromise', async (...args) => {
    const reader = await open(...args)
    readers.add(reader)
    reader.once('close', () => readers.delete(reader))
    return reader
  })
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (path.basename(source).startsWith('download-')) {
      assert.equal(readers.size, 0, 'Toolkit cache promotion must not race open ZIP handles')
    }
    return rename(source, destination)
  })
  const prepared = await toolkit.prepareToolkit(path.join(root, 'workspace'), { reference: published.reference })
  assert.equal(prepared.reused, false)
})
