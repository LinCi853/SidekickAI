'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const AdmZip = require('adm-zip')
const builder = require('./build-host-backup.cjs')
const root = path.resolve(__dirname, '..')
const parent = path.join(root, 'build/test-fixtures')
fs.mkdirSync(parent, { recursive: true })
const base = fs.mkdtempSync(path.join(parent, 'host-backup-'))
const metadata = builder.identity('x64')
let script
let counter = 0
function request(operation, fields = {}) {
  return {
    protocolVersion: 1,
    requestId: `fixture-${++counter}`,
    operation,
    productId: metadata.productId,
    edition: metadata.edition,
    productVersion: metadata.productVersion,
    ...fields,
  }
}
function invoke(raw, executable = process.execPath, entry = script) {
  const result = spawnSync(executable, [entry], {
    input: typeof raw === 'string' ? raw : JSON.stringify(raw),
    cwd: base,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 17 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' },
  })
  assert.ifError(result.error)
  const response = JSON.parse(result.stdout)
  assert.equal(result.status, response.success ? 0 : 1, result.stderr)
  assert.equal(response.protocolVersion, 1)
  assert.equal(response.status, response.success ? 'completed' : 'failed')
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 * 1024)
  return response
}
function fixture() {
  const directory = path.join(base, `data-${++counter}`)
  const sourceRoot = path.join(directory, 'source')
  fs.mkdirSync(sourceRoot, { recursive: true })
  const db = new DatabaseSync(path.join(sourceRoot, 'settings.db'))
  db.exec(
    "CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE module_state(id TEXT PRIMARY KEY); INSERT INTO app_settings VALUES('fixture','original')",
  )
  db.close()
  fs.writeFileSync(
    path.join(sourceRoot, 'edition-identity.json'),
    JSON.stringify({ schema: 1, edition: 'sidekickai-opensource' }),
  )
  fs.writeFileSync(path.join(sourceRoot, 'unknown.txt'), 'retained')
  fs.mkdirSync(path.join(sourceRoot, 'Cache'))
  fs.writeFileSync(path.join(sourceRoot, 'Cache/cache.txt'), 'optional')
  return {
    directory,
    sourceRoot,
    tempRoot: path.join(directory, 'jobs'),
    targetPath: path.join(directory, 'backup.zip'),
    format: 'zip',
    categories: ['basicData'],
  }
}
function exported(fields = {}) {
  const target = { ...fixture(), ...fields }
  const { directory, ...input } = target
  const response = invoke(request('export', input))
  assert.equal(response.success, true, JSON.stringify(response.error))
  return { target, proof: response.result }
}
before(async () => {
  const output = await builder.bundle('x64')
  script = path.join(base, 'backup-component.cjs')
  fs.writeFileSync(script, output.outputFiles[0].contents)
})
after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }))

test('describe uses embedded identity and does not create profile or staging directories', () => {
  const before = fs.readdirSync(base)
  const response = invoke(request('describe'))
  assert.equal(response.success, true)
  assert.equal(response.result.edition, 'concept')
  assert.equal(response.result.productVersion, metadata.productVersion)
  assert.equal(response.result.files, undefined)
  assert.deepEqual(response.result.operations, [
    'describe',
    'export',
    'verify',
    'decrypt',
    'restore',
  ])
  assert.deepEqual(fs.readdirSync(base), before)
})

test('unknown fields, operations, versions and identities fail before side effects', () => {
  for (const patch of [
    { operation: 'options' },
    { protocolVersion: 2 },
    { productId: 'foreign' },
    { edition: 'community' },
    { productVersion: '99.0.0' },
    { sourceRoot: 'not-allowed-for-describe' },
    { extra: true },
  ]) {
    const response = invoke(request('describe', patch))
    assert.equal(response.success, false)
    assert.equal(response.error.code, 'INPUT_INVALID')
  }
  const target = fixture()
  const { directory, ...fields } = target
  assert.equal(invoke(request('export', { ...fields, productVersion: 'wrong' })).success, false)
  assert.equal(fs.existsSync(target.tempRoot), false)
  assert.equal(fs.existsSync(target.targetPath), false)
})

test('bounded stdin rejects malformed, oversized and invalid typed requests', () => {
  for (const input of [
    '{',
    '[]',
    'x'.repeat(8 * 1024 * 1024 + 1),
    JSON.stringify(
      request('export', {
        sourceRoot: base,
        targetPath: path.join(base, 'no.zip'),
        format: 'zip',
        categories: ['basicData', 'foreign'],
      }),
    ),
  ]) {
    assert.equal(invoke(input).success, false)
  }
})

test('strict export and receipt-bound verify match actual archive bytes and selected source inventory', () => {
  const { target, proof } = exported()
  assert.equal(proof.strict, true)
  assert.equal(proof.validation, 'strict-export-v1')
  assert.equal(proof.treeAlgorithm, 'export-tree-digest-v1')
  assert.deepEqual(proof.skippedFiles, [])
  assert.equal(proof.sourceEntries['Cache/cache.txt'], undefined)
  assert.match(proof.sourceEntries['unknown.txt'], /^[a-f0-9]{64}$/)
  assert.equal(proof.entryCount, Object.keys(proof.sourceEntries).length)
  assert.equal(proof.artifactSize, fs.statSync(target.targetPath).size)
  assert.equal(proof.manifest, undefined)
  const verified = invoke(
    request('verify', {
      inputPath: target.targetPath,
      sourceRoot: target.sourceRoot,
      categories: target.categories,
      exportReceipt: proof,
    }),
  )
  assert.deepEqual(verified.result, proof)
  const generic = invoke(request('verify', { inputPath: target.targetPath }))
  assert.equal(generic.result.validation, 'archive-v1')
  assert.equal(generic.result.sourceEntries, undefined)
  assert.equal(generic.result.manifest, undefined)
})

test('receipt tampering cannot change artifact, source, selection or validation binding', () => {
  const { target, proof } = exported()
  for (const patch of [
    { artifactSha256: '0'.repeat(64) },
    { artifactSize: 1 },
    { entryCount: 999 },
    {
      sourceEntries: { ...proof.sourceEntries, 'unknown.txt': '0'.repeat(64) },
    },
    { categories: ['basicData', 'cache'] },
    { validation: 'archive-v1' },
    { treeSha256: '0'.repeat(64) },
    { format: 'sabackup' },
    { filePath: path.join(base, 'other.zip') },
    { extra: true },
  ]) {
    const response = invoke(
      request('verify', {
        inputPath: target.targetPath,
        exportReceipt: { ...proof, ...patch },
      }),
    )
    assert.equal(response.success, false, JSON.stringify(patch))
  }
})

test('changed source including an excluded category rejects strict verification', () => {
  const { target, proof } = exported()
  fs.writeFileSync(path.join(target.sourceRoot, 'Cache/cache.txt'), 'changed')
  const verified = invoke(request('verify', { inputPath: target.targetPath, exportReceipt: proof }))
  assert.equal(verified.success, false)
  assert.equal(verified.error.code, 'SOURCE_CHANGED')
  assert.equal(invoke(request('verify', { inputPath: target.targetPath })).success, true)
})

test('encrypted export, decrypt and new-directory restore round trip without exposing manifest or persisting passwords', () => {
  const password = 'fixture-only-secret-never-persist'
  const { target, proof } = exported({ format: 'sabackup', password })
  const verified = invoke(
    request('verify', {
      inputPath: target.targetPath,
      password,
      exportReceipt: proof,
      tempRoot: target.tempRoot,
    }),
  )
  assert.equal(verified.success, true)
  const decrypted = path.join(target.directory, 'decrypted.zip')
  const result = invoke(
    request('decrypt', {
      inputPath: target.targetPath,
      targetPath: decrypted,
      password,
      tempRoot: target.tempRoot,
    }),
  )
  assert.equal(result.success, true)
  assert.equal(result.result.validation, 'archive-v1')
  assert.equal(result.result.targetSize, fs.statSync(decrypted).size)
  assert.match(result.result.targetSha256, /^[a-f0-9]{64}$/)
  assert.equal(result.result.manifest, undefined)
  const restored = path.join(target.directory, 'restored')
  assert.equal(
    invoke(
      request('restore', {
        inputPath: target.targetPath,
        targetPath: restored,
        password,
        tempRoot: target.tempRoot,
      }),
    ).success,
    true,
  )
  assert.equal(fs.readFileSync(path.join(restored, 'unknown.txt'), 'utf8'), 'retained')
  assert.equal(
    invoke(
      request('restore', {
        inputPath: target.targetPath,
        targetPath: restored,
        password,
        tempRoot: target.tempRoot,
      }),
    ).success,
    false,
  )
  function inspect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) inspect(file)
      else if (/\.(json|jsonl)$/.test(entry.name))
        assert.equal(fs.readFileSync(file, 'utf8').includes(password), false)
    }
  }
  inspect(target.directory)
  assert.equal(JSON.stringify(result).includes(password), false)
})

test('wrong passwords and corrupt archives publish no decrypt or restore destinations', () => {
  const { target } = exported({
    format: 'sabackup',
    password: 'correct-fixture-password',
  })
  for (const operation of ['decrypt', 'restore']) {
    const destination = path.join(target.directory, operation)
    const result = invoke(
      request(operation, {
        inputPath: target.targetPath,
        targetPath: destination,
        password: 'wrong-password',
        tempRoot: target.tempRoot,
      }),
    )
    assert.equal(result.success, false)
    assert.equal(fs.existsSync(destination), false)
    assert.equal(JSON.stringify(result).includes('wrong-password'), false)
  }
  const plain = exported()
  const zip = new AdmZip(plain.target.targetPath)
  zip.updateFile('unknown.txt', Buffer.from('corrupt'))
  zip.writeZip(plain.target.targetPath)
  const destination = path.join(plain.target.directory, 'corrupt-restored')
  assert.equal(
    invoke(
      request('restore', {
        inputPath: plain.target.targetPath,
        targetPath: destination,
      }),
    ).success,
    false,
  )
  assert.equal(fs.existsSync(destination), false)
  assert.equal(
    invoke(
      request('verify', {
        inputPath: plain.target.targetPath,
        exportReceipt: plain.proof,
      }),
    ).success,
    false,
  )
})

test('export refuses foreign data identity and destinations inside source', () => {
  const target = fixture()
  const { directory, ...fields } = target
  assert.equal(
    invoke(
      request('export', {
        ...fields,
        targetPath: path.join(target.sourceRoot, 'backup.zip'),
      }),
    ).success,
    false,
  )
  fs.writeFileSync(
    path.join(target.sourceRoot, 'edition-identity.json'),
    JSON.stringify({ schema: 1, edition: 'sidekick-ai' }),
  )
  assert.equal(invoke(request('export', fields)).success, false)
  assert.equal(fs.existsSync(target.tempRoot), false)
})

test('builtins guard rejects external dependencies', () => {
  assert.throws(
    () =>
      builder.assertIndependentImports({
        outputs: { bundle: { imports: [{ path: 'electron' }] } },
      }),
    /external application dependency/,
  )
})

test('packaged component closes runtime inventory, executes pinned x64 Node, and rejects changed closure', {
  skip: !process.env.SIDEKICK_BACKUP_RUNTIME_CACHE,
}, async () => {
  for (const architecture of ['x64', 'arm64']) {
    const directory = path.join(base, `component-${architecture}`)
    const descriptor = await builder.buildComponent(directory, architecture)
    assert.equal(
      descriptor.files.some((file) => file.path === 'component.json'),
      false,
    )
    assert.equal(descriptor.files.length, 5)
    assert.deepEqual(descriptor, builder.verifyComponent(directory, architecture))
    if (architecture === 'x64') {
      const application = await require('./test-fixtures/application-runtime.cjs').createRuntime(
        path.join(base, 'payload-source'),
        architecture,
      )
      await builder.afterPack({
        electronPlatformName: 'win32',
        appOutDir: application,
        arch: 1,
      })
      const artifact = require('./application-payload.cjs').packApplicationPayload({
        source: application,
        output: path.join(base, 'payload'),
        architecture,
      })
      const inventory = new Map(artifact.manifest.files.map((file) => [file.path, file]))
      assert.ok(inventory.has('resources/host-backup/component.json'))
      assert.ok(inventory.has('resources/product-descriptor.json'))
      for (const file of descriptor.files)
        assert.ok(inventory.has('resources/host-backup/' + file.path))
      const zip = new AdmZip(artifact.path)
      const product = JSON.parse(zip.readAsText('resources/product-descriptor.json'))
      assert.equal(product.backupComponent, 'resources/host-backup/component.json')
      require('./application-payload.cjs').verifyApplicationPayload(
        artifact.path,
        artifact.manifest,
      )
      const result = invoke(
        request('describe'),
        path.join(directory, 'node.exe'),
        path.join(directory, 'backup-component.cjs'),
      )
      const { files, ...expected } = descriptor
      assert.deepEqual(result.result, expected)
      const target = fixture()
      const { directory: unused, ...input } = target
      const native = (value) =>
        invoke(
          value,
          path.join(directory, 'node.exe'),
          path.join(directory, 'backup-component.cjs'),
        )
      const captured = native(
        request('export', { ...input, format: 'sabackup', password: 'native-fixture-password' }),
      )
      assert.equal(captured.success, true, JSON.stringify(captured.error))
      assert.equal(
        native(
          request('verify', {
            inputPath: target.targetPath,
            password: 'native-fixture-password',
            tempRoot: target.tempRoot,
            exportReceipt: captured.result,
          }),
        ).success,
        true,
      )
      assert.equal(
        native(
          request('restore', {
            inputPath: target.targetPath,
            targetPath: path.join(target.directory, 'native-restored'),
            password: 'native-fixture-password',
            tempRoot: target.tempRoot,
          }),
        ).success,
        true,
      )
    }
    fs.appendFileSync(path.join(directory, 'backup-component.cjs'), '\n// changed')
    assert.throws(() => builder.verifyComponent(directory, architecture), /identity mismatch/)
  }
})
