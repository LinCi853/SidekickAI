const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const AdmZip = require('adm-zip')
const { prepare } = require('./build-backup-runtime.cjs')

test('the pinned independent runtime exports and restores data without the installed application', { timeout: 120000 }, async () => {
  const archive = await prepare('x64')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-independent-export-'))
  const source = path.join(directory, 'source')
  fs.mkdirSync(source)
  const database = new DatabaseSync(path.join(source, 'settings.db'))
  database.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE module_state(id TEXT PRIMARY KEY); INSERT INTO app_settings VALUES ('fixture', 'recoverable')")
  database.close()
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'settings.db'))).digest('hex')
  const runtime = path.join(directory, 'runtime')
  const cli = path.join(runtime, 'sidekick-backup.cjs')
  try {
    const zip = new AdmZip(archive)
    const manifest = JSON.parse(zip.readAsText('manifest.json'))
    const contract = require('../packages/backup-core/runtime-manifest.json')
    const payloads = ['node.exe', 'export.mjs', 'sidekick-backup.cjs', 'FORMAT.md', 'sabk-v1-vector.json', 'LICENSE.txt', 'SidekickAI-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'].sort()
    assert.equal(manifest.arch, 'x64')
    assert.equal(manifest.nodeVersion, contract.nodeVersion)
    assert.equal(manifest.executableSha256, contract.architectures.x64)
    assert.equal(manifest.files['node.exe'], manifest.executableSha256)
    assert.equal(manifest.files['export.mjs'], manifest.scriptSha256)
    assert.deepEqual(Object.keys(manifest.files).sort(), payloads)
    assert.deepEqual(zip.getEntries().map(entry => entry.entryName).sort(), [...payloads, 'manifest.json'].sort())
    for (const entry of zip.getEntries()) {
      assert.equal(entry.isDirectory, false)
      if (entry.entryName === 'manifest.json') continue
      assert.match(manifest.files[entry.entryName], /^[a-f0-9]{64}$/)
      assert.equal(crypto.createHash('sha256').update(entry.getData()).digest('hex'), manifest.files[entry.entryName], entry.entryName)
    }
    zip.extractAllTo(runtime, false)
    assert.deepEqual(fs.readdirSync(runtime).sort(), [...payloads, 'manifest.json'].sort())
    for (const name of payloads) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, name))).digest('hex'), manifest.files[name], name)
    for (const encrypted of [false, true]) {
      const target = path.join(directory, encrypted ? 'backup.sabackup' : 'backup.zip')
      const resultPath = `${target}.json`
      const request = { sourceRoot: source, edition: require('../product-edition.json').edition, version: require('../package.json').version, targetPath: target, resultPath,
        tempRoot: path.join(directory, 'jobs'), strict: true, options: { basicData: true, cookies: true, indexedDB: true, cache: true }, password: encrypted ? 'independent-fixture-password' : undefined }
      const child = spawnSync(path.join(runtime, 'node.exe'), [path.join(runtime, 'export.mjs')], { input: JSON.stringify(request), cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 45000 })
      assert.equal(child.status, 0, child.stderr)
      const receipt = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      assert.equal(receipt.ok, true, receipt.error)
      assert.equal(receipt.strict, true)
      assert.equal(receipt.sourceEntries['settings.db'], sourceHash)
      assert.match(receipt.treeSha256, /^[a-f0-9]{64}$/)
      assert.equal(fs.readFileSync(resultPath, 'utf8').includes('independent-fixture-password'), false)
      const restored = path.join(directory, encrypted ? 'restored-encrypted' : 'restored-plain')
      const restore = spawnSync(path.join(runtime, 'node.exe'), [cli, 'restore', '--file', target, '--target', restored, ...(encrypted ? ['--password-stdin'] : [])], {
        input: encrypted ? 'independent-fixture-password\n' : '', encoding: 'utf8', cwd: directory, windowsHide: true, timeout: 45000,
      })
      assert.equal(restore.status, 0, restore.stderr)
      assert.equal(JSON.parse(restore.stdout).success, true)
      const opened = new DatabaseSync(path.join(restored, 'settings.db'), { readOnly: true })
      try { assert.equal(opened.prepare("SELECT value FROM app_settings WHERE key='fixture'").get().value, 'recoverable') }
      finally { opened.close() }
    }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'settings.db'))).digest('hex'), sourceHash)
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('sidekick-independent-export-'))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
