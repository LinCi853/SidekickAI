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
const {
  fixtureRoot,
  toolkitFixture,
  writeToolkit,
} = require('./test-fixtures/distribution-toolkit.cjs')

const CACHE = 'build/component-cache/lifecycle-toolkit'

function pinnedReference() {
  return structuredClone(require('../contracts/distribution-toolkit.json'))
}

function rehash(entries) {
  return entries.map((entry) => ({
    path: entry.name,
    size: entry.bytes.length,
    sha256: u.hash(entry.bytes),
  }))
}

function entryNamed(fixture, name) {
  const entry = fixture.entries.find((item) => item.name === name)
  assert.ok(entry, 'Fixture lost ' + name)
  return entry
}

const foreignIdentities = [
  [
    'version',
    (value) => {
      value.toolkitVersion += '-foreign'
    },
    /version.*trusted release/i,
  ],
  [
    'size',
    (value) => {
      value.archive.size++
    },
    /size.*trusted release/i,
  ],
  [
    'digest',
    (value) => {
      value.archive.sha256 = '0'.repeat(64)
    },
    /SHA-256.*trusted release/i,
  ],
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

test('production acquisition rejects foreign identities before archive access or cache creation', async (t) => {
  for (const selection of ['default', 'environment', 'direct']) {
    for (const [name, change, expected] of foreignIdentities)
      await t.test(selection + ':' + name, async (sub) => {
        const root = fixtureRoot(sub)
        const reference = pinnedReference()
        reference.archive.path = 'vendor/distribution/unread.zip'
        change(reference)
        const referenceFile = path.join(
          root,
          selection === 'default' ? 'contracts/distribution-toolkit.json' : 'reference.json',
        )
        fs.mkdirSync(path.dirname(referenceFile), { recursive: true })
        fs.writeFileSync(referenceFile, JSON.stringify(reference))
        const previous = process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
        if (selection === 'environment')
          process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE = referenceFile
        else delete process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
        sub.after(() => {
          if (previous === undefined) delete process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE
          else process.env.SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE = previous
        })
        const archivePath = path.join(root, reference.archive.path)
        const read = fs.readFileSync
        sub.mock.method(fs, 'readFileSync', (file, ...args) => {
          assert.notEqual(
            path.resolve(file),
            archivePath,
            'Foreign references must not read archive bytes',
          )
          return read(file, ...args)
        })
        sub.mock.method(u, 'sha256', () =>
          assert.fail('Foreign references must not hash archive bytes'),
        )
        sub.mock.method(fs, 'createReadStream', () =>
          assert.fail('Foreign references must not stream archive bytes'),
        )
        sub.mock.method(yauzl, 'openPromise', () =>
          assert.fail('Foreign references must not open ZIP entries'),
        )
        const options = {
          fetch() {
            assert.fail('Foreign references must not download archive bytes')
          },
        }
        if (selection === 'direct') options.reference = reference
        await assert.rejects(toolkit.prepareToolkit(root, options), expected)
        assert.equal(fs.existsSync(path.join(root, 'build')), false)
      })
  }
})

async function localServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return 'http://127.0.0.1:' + server.address().port
}

test('toolkit references pin the protocol, version, size, digest and explicit source', () => {
  const reference = pinnedReference()
  assert.equal(toolkit.validateReference(reference), reference)
  const https = structuredClone(reference)
  delete https.archive.path
  https.archive.url = 'https://example.invalid/downloads/toolkit.zip?version=0.1.7'
  assert.equal(toolkit.validateReference(https), https)
  for (const [name, change] of [
    [
      'protocol',
      (value) => {
        value.interfaceVersion = 2
      },
    ],
    [
      'version suffix',
      (value) => {
        value.toolkitVersion += '\n'
      },
    ],
    [
      'version leading zero',
      (value) => {
        value.toolkitVersion = '00.1.7'
      },
    ],
    [
      'missing pin',
      (value) => {
        delete value.archive.sha256
      },
    ],
    [
      'zero size',
      (value) => {
        value.archive.size = 0
      },
    ],
    [
      'fractional size',
      (value) => {
        value.archive.size = 1.5
      },
    ],
    [
      'oversized archive',
      (value) => {
        value.archive.size = toolkit.MAX_ARCHIVE_BYTES + 1
      },
    ],
    [
      'uppercase digest',
      (value) => {
        value.archive.sha256 = 'A'.repeat(64)
      },
    ],
    [
      'unknown property',
      (value) => {
        value.downloadLatest = true
      },
    ],
  ]) {
    const value = structuredClone(reference)
    change(value)
    assert.throws(() => toolkit.validateReference(value), undefined, name)
  }
  for (const url of [
    'http://example.invalid/toolkit.zip',
    'ftp://example.invalid/toolkit.zip',
    'https://user:password@example.invalid/toolkit.zip',
    'https://example.invalid/toolkit.zip#fragment',
    'file://server/share/toolkit.zip',
    './toolkit.zip',
  ]) {
    const value = structuredClone(https)
    value.archive.url = url
    assert.throws(() => toolkit.validateReference(value, { allowLoopback: true }), undefined, url)
  }
  const loopback = structuredClone(https)
  loopback.archive.url = 'http://127.0.0.1:12345/toolkit.zip'
  assert.throws(() => toolkit.validateReference(loopback), /HTTPS/)
  assert.equal(toolkit.validateReference(loopback, { allowLoopback: true }), loopback)
})

test('toolkit reference selection has no implicit sibling workspace fallback', (t) => {
  const root = fixtureRoot(t)
  const reference = pinnedReference()
  assert.throws(
    () => toolkit.readReference(root, { env: {} }),
    /SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE/,
  )
  const referenceFile = path.join(root, 'selected-reference.json')
  fs.writeFileSync(referenceFile, JSON.stringify(reference))
  const selected = { file: referenceFile, reference, sha256: u.sha256(referenceFile) }
  assert.deepEqual(toolkit.readReference(root, { referenceFile }), selected)
  assert.deepEqual(
    toolkit.readReference(root, {
      env: { SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE: referenceFile },
    }),
    selected,
  )
  fs.writeFileSync(referenceFile, ' '.repeat(toolkit.MAX_REFERENCE_BYTES + 1))
  assert.throws(() => toolkit.readReference(root, { referenceFile }), /size limit/)
})

test('the default project pin resolves its archive within the workspace', async (t) => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'vendor/distribution'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  delete reference.archive.url
  reference.archive.path = path.relative(root, published.archive).replaceAll('\\', '/')
  fs.mkdirSync(path.join(root, 'contracts'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'contracts/distribution-toolkit.json'),
    JSON.stringify(reference),
  )
  const prepared = await toolkit.prepareToolkit(root)
  assert.deepEqual(prepared.reference, reference)
  assert.equal(prepared.referenceFile, path.join(root, 'contracts/distribution-toolkit.json'))
  assert.equal(prepared.version, reference.toolkitVersion)
  assert.deepEqual(prepared.files, published.inventory)
  assert.equal((await toolkit.prepareToolkit(root)).reused, true)
  for (const archivePath of [
    '../toolkit.zip',
    'C:/toolkit.zip',
    '/toolkit.zip',
    'vendor\\toolkit.zip',
    'vendor/../toolkit.zip',
  ]) {
    assert.throws(
      () =>
        toolkit.validateReference({
          ...reference,
          archive: { ...reference.archive, path: archivePath },
        }),
      undefined,
      archivePath,
    )
  }
  assert.throws(
    () =>
      toolkit.validateReference({
        ...reference,
        archive: { ...reference.archive, url: published.reference.archive.url },
      }),
    /exactly one/,
  )
  const withoutLocation = structuredClone(reference)
  delete withoutLocation.archive.path
  assert.throws(() => toolkit.validateReference(withoutLocation), /exactly one/)
})

test('project pins fail when their local archive is absent or linked outside the project', async (t) => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'outside'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  delete reference.archive.url
  reference.archive.path = 'vendor/distribution/toolkit.zip'
  await assert.rejects(toolkit.prepareToolkit(root, { reference }), /file|ENOENT/i)
  fs.mkdirSync(path.join(root, 'vendor'))
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(root, 'vendor/distribution'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(toolkit.prepareToolkit(root, { reference }), /filesystem links/)
})

test('warm project caches still require the original archive bytes and an unlinked source', async (t) => {
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
    () =>
      fs.writeFileSync(
        published.archive,
        'version https://git-lfs.github.com/spec/v1\noid sha256:' +
          reference.archive.sha256 +
          '\nsize ' +
          reference.archive.size +
          '\n',
      ),
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

test('a real loopback download verifies a complete toolkit and reuses a rechecked cache', async (t) => {
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
  assert.equal(first.version, '0.1.7')
  assert.deepEqual(first.files, published.inventory)
  assert.equal(
    first.directory,
    path.join(root, 'workspace', CACHE, reference.archive.sha256, 'toolkit'),
  )
  const second = await toolkit.prepareToolkit(path.join(root, 'workspace'), {
    ...options,
    fetch() {
      throw new Error('A valid cache must not download again')
    },
  })
  assert.equal(second.reused, true)
  assert.deepEqual(first.inputs, second.inputs)
  assert.equal(requests, 1)
  toolkit.assertUnchanged(first)
})

test('download errors and pin mismatches never promote an unverified cache entry', async (t) => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const bytes = fs.readFileSync(published.archive)
  const origin = await localServer(t, (request, response) => {
    if (request.url === '/failed') {
      response.writeHead(503)
      response.end('unavailable')
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/archive' })
      response.end()
      return
    }
    const changed = Buffer.from(bytes)
    changed[0] ^= 1
    response.end(
      request.url === '/short'
        ? bytes.subarray(0, bytes.length - 1)
        : request.url === '/changed'
          ? changed
          : request.url === '/long'
            ? Buffer.concat([bytes, Buffer.from('extra')])
            : bytes,
    )
  })
  for (const [name, route, expected] of [
    ['http-error', '/failed', /HTTP 503/],
    ['truncated', '/short', /pinned size and SHA-256/],
    ['excess', '/long', /exceeds its declared size/],
    ['digest', '/changed', /pinned size and SHA-256/],
  ])
    await t.test(name, async () => {
      const reference = structuredClone(published.reference)
      reference.archive.url = origin + route
      const workspace = path.join(root, name)
      await assert.rejects(
        toolkit.prepareToolkit(workspace, { reference, allowLoopback: true }),
        expected,
      )
      assert.equal(fs.existsSync(path.join(workspace, CACHE, reference.archive.sha256)), false)
    })
  const redirected = structuredClone(published.reference)
  redirected.archive.url = origin + '/redirect'
  assert.equal(
    (
      await toolkit.prepareToolkit(path.join(root, 'redirected'), {
        reference: redirected,
        allowLoopback: true,
      })
    ).reused,
    false,
  )
})

test('download responses cannot change an HTTPS reference to an unapproved transport', async (t) => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const reference = structuredClone(published.reference)
  reference.archive.url = 'https://example.invalid/toolkit.zip'
  await assert.rejects(
    toolkit.prepareToolkit(path.join(root, 'workspace'), {
      reference,
      fetch: async () => {
        const response = new Response(fs.readFileSync(published.archive))
        Object.defineProperty(response, 'url', { value: 'http://example.invalid/toolkit.zip' })
        return response
      },
    }),
    /HTTPS/,
  )
})

test('the published inventory is the fixed twenty-three-file 0.1.11 layout without a manifest', () => {
  const expected = [
    'bin/AppLifecycleToolkit.exe',
    'README.md',
    'sample/app.manifest.jsonc',
    ...['concept', 'community'].flatMap((edition) =>
      ['x64', 'arm64'].flatMap((arch) => [
        'extractor/' + edition + '/' + arch + '/setup.exe',
        'extractor/' + edition + '/' + arch + '/wizard-manifest.json',
        'uninstallers/' + edition + '/' + arch + '/uninstall.exe',
        'uninstallers/' + edition + '/' + arch + '/uninstall-manifest.json',
        'uninstallers/' + edition + '/' + arch + '/product-edition.json',
      ]),
    ),
  ].sort()
  const paths = toolkit.INVENTORY.map((file) => file.path).sort()
  assert.deepEqual(paths, expected)
  assert.equal(toolkit.INVENTORY.length, 23)
  for (const retired of ['toolkit-manifest.json', 'bin/SidekickDistribution.exe', 'LICENSE.txt']) {
    assert.equal(paths.includes(retired), false, retired)
  }
  assert.equal(
    toolkit.INVENTORY.find((file) => file.path === 'bin/AppLifecycleToolkit.exe').size > 0,
    true,
  )
})

test('extracted toolkits must match the fixed inventory exactly and stay unlinked', async (t) => {
  for (const [name, change, expected] of [
    [
      'extra-resource',
      (value) => fs.writeFileSync(path.join(value.directory, 'extra.txt'), 'unlisted'),
      /unexpected files/,
    ],
    [
      'missing-resource',
      (value) => fs.unlinkSync(path.join(value.directory, 'README.md')),
      /unexpected files/,
    ],
    [
      'changed-resource',
      (value) => fs.appendFileSync(path.join(value.directory, 'README.md'), 'changed'),
      /pinned identity/,
    ],
    [
      'non-file-resource',
      (value) => {
        fs.unlinkSync(path.join(value.directory, 'README.md'))
        fs.mkdirSync(path.join(value.directory, 'README.md'))
      },
      /unexpected files/,
    ],
    [
      'linked-root',
      (value) => {
        fs.renameSync(value.directory, value.directory + '-original')
        fs.symlinkSync(value.directory + '-original', value.directory, 'junction')
      },
      /regular directory/,
    ],
  ])
    await t.test(name, async (sub) => {
      const root = fixtureRoot(sub)
      const published = writeToolkit(path.join(root, 'published'))
      const toolkit = published.toolkit
      const workspace = path.join(root, 'workspace')
      const prepared = await toolkit.prepareToolkit(workspace, { reference: published.reference })
      change(prepared)
      await assert.rejects(
        toolkit.prepareToolkit(workspace, { reference: published.reference }),
        expected,
      )
      assert.throws(() => toolkit.assertUnchanged(prepared))
    })
})

test('component manifests must match their executable, edition and architecture', async (t) => {
  const root = fixtureRoot(t)
  for (const [name, change] of [
    [
      'protocol',
      (manifest) => {
        manifest.protocolVersion = 2
      },
    ],
    [
      'uninstall-protocol',
      (manifest) => {
        manifest.uninstallProtocolVersion = 1
      },
    ],
    [
      'edition',
      (manifest) => {
        manifest.edition = 'community'
      },
    ],
    [
      'architecture',
      (manifest) => {
        manifest.arch = 'arm64'
      },
    ],
    [
      'size',
      (manifest) => {
        manifest.size += 1
      },
    ],
    [
      'digest',
      (manifest) => {
        manifest.sha256 = '0'.repeat(64)
      },
    ],
  ])
    await t.test(name, async (sub) => {
      const fixture = toolkitFixture()
      const entry = entryNamed(fixture, 'extractor/concept/x64/wizard-manifest.json')
      const manifest = JSON.parse(entry.bytes)
      change(manifest)
      entry.bytes = Buffer.from(JSON.stringify(manifest) + '\n')
      const published = writeToolkit(path.join(root, name), {
        ...fixture,
        inventory: rehash(fixture.entries),
      })
      await assert.rejects(
        published.toolkit.prepareToolkit(path.join(root, name, 'workspace'), {
          reference: published.reference,
        }),
        /component manifest/,
      )
    })
})

test('matching archive and inventory hashes cannot conceal an executable architecture mismatch', async (t) => {
  const root = fixtureRoot(t)
  for (const target of ['bin/AppLifecycleToolkit.exe', 'extractor/concept/x64/setup.exe'])
    await t.test(target, async (sub) => {
      const fixture = toolkitFixture()
      const entry = entryNamed(fixture, target)
      entry.bytes = pe('arm64')
      const published = writeToolkit(path.join(root, target.replaceAll(/[\\/]/g, '_')), {
        ...fixture,
        inventory: rehash(fixture.entries),
      })
      await assert.rejects(
        published.toolkit.prepareToolkit(
          path.join(root, target.replaceAll(/[\\/]/g, '_'), 'workspace'),
          {
            reference: published.reference,
          },
        ),
        /native architecture/,
      )
    })
})

// 0.1.7 has no manifest that could advertise file modes, so ZIP mode bits are not a
// rejection criterion; the pinned reference binds the archive bytes and the fixed inventory
// binds the extracted content.
test('real toolkit ZIP parsing rejects duplicate, unsafe, extra and altered entries', async (t) => {
  for (const [name, change] of [
    [
      'duplicate-file',
      (value) => {
        value.entries.push({ ...value.entries[0] })
      },
    ],
    [
      'case-collision',
      (value) => {
        value.entries.push({ name: 'readme.md', bytes: Buffer.from('extra') })
      },
    ],
    [
      'extra-file',
      (value) => {
        value.entries.push({ name: 'unlisted.txt', bytes: Buffer.from('extra') })
      },
    ],
    [
      'missing-file',
      (value) => {
        value.entries.pop()
      },
    ],
    [
      'wrong-content',
      (value) => {
        value.entries.at(-1).bytes = Buffer.from('Changed component manifest\n')
      },
    ],
    [
      'traversal',
      (value) => {
        value.entries.push({ name: '../outside.txt', bytes: Buffer.from('extra') })
      },
    ],
    [
      'absolute',
      (value) => {
        value.entries.push({ name: '/outside.txt', bytes: Buffer.from('extra') })
      },
    ],
    [
      'backslash',
      (value) => {
        value.entries.push({ name: 'bin\\outside.txt', bytes: Buffer.from('extra') })
      },
    ],
  ])
    await t.test(name, async (sub) => {
      const root = fixtureRoot(sub)
      const fixture = toolkitFixture()
      change(fixture)
      const published = writeToolkit(path.join(root, 'published'), fixture)
      await assert.rejects(
        published.toolkit.prepareToolkit(path.join(root, 'workspace'), {
          reference: published.reference,
        }),
      )
      assert.equal(
        fs.existsSync(path.join(root, 'workspace', CACHE, published.reference.archive.sha256)),
        false,
      )
      assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false)
    })
})

test('a selected reference file cannot change between preparation and binary invocation', async (t) => {
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

test('cache promotion waits until all archive reader handles have closed', async (t) => {
  const root = fixtureRoot(t)
  const published = writeToolkit(path.join(root, 'published'))
  const toolkit = published.toolkit
  const open = yauzl.openPromise
  const rename = fs.promises.rename
  const readers = new Set()
  t.mock.method(yauzl, 'openPromise', async (...args) => {
    const reader = await open(...args)
    readers.add(reader)
    reader.once('close', () => readers.delete(reader))
    return reader
  })
  let promotions = 0
  t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (path.basename(source).startsWith('download-')) {
      promotions++
      assert.equal(readers.size, 0, 'Toolkit cache promotion must not race open ZIP handles')
      if (promotions === 1)
        throw Object.assign(new Error('Temporary Windows directory lock'), { code: 'EPERM' })
    }
    return rename(source, destination)
  })
  const prepared = await toolkit.prepareToolkit(path.join(root, 'workspace'), {
    reference: published.reference,
  })
  assert.equal(prepared.reused, false)
  assert.ok(promotions >= 2)
})
