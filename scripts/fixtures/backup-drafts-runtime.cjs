const { app, safeStorage, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')
const core = require('./core.cjs')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const base = argument('root')
const mode = argument('mode')
const cookies = argument('cookies') === 'true'
const encrypted = argument('encrypted') === 'true'
const offline = argument('offline') === 'true'
const edition = argument('edition')
const source = base && path.join(base, 'source')
const root = base && path.join(base, ['restore', 'cold'].includes(mode) ? 'target' : mode === 'offline' ? 'helper' : 'source')
const archive = base && path.join(base, encrypted ? 'backup.sabackup' : 'backup.zip')
const key = 'windowDraft:settings:network'
const value = { provider: 'isolated-sensitive-draft', nested: { enabled: true } }
const password = 'isolated-sensitive-password'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidenceFile = base && path.join(base, 'evidence.json')
const evidence = () => JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
const save = fields => fs.writeFileSync(evidenceFile, JSON.stringify({ ...(fs.existsSync(evidenceFile) ? evidence() : {}), ...fields }, null, 2))
if (core.cookieHelperRequestPath) core.initializeCookieHelper()
else {
  fs.mkdirSync(root, { recursive: true })
  app.setPath('userData', root)
  app.setPath('sessionData', root)
}
function readDraft(directory) {
  const db = new Database(path.join(directory, 'settings.db'), { readonly: true })
  try { return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value }
  finally { db.close() }
}
function inventory(directory) {
  const result = [{ category: 'basicData', sourcePath: path.join(directory, 'settings.db'), archivePath: 'settings.db' }]
  if (cookies) for (const name of ['Local State', 'Cookies', 'Network/Cookies']) {
    const file = path.join(directory, name)
    if (fs.existsSync(file)) result.push({ category: 'cookies', sourcePath: file, archivePath: name })
  }
  return result
}
app.whenReady().then(async () => {
  if (core.cookieHelperRequestPath) { app.exit(await core.runCookieSnapshotHelper()); return }
  assert.equal(safeStorage.isEncryptionAvailable(), true)
  if (mode === 'seed' || mode === 'live') {
    const db = new Database(path.join(root, 'settings.db'))
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO app_settings VALUES (?,?)').run(key, safeStorage.encryptString(JSON.stringify(value)).toString('base64'))
    db.close()
    await session.defaultSession.cookies.set({ url: 'https://draft-fixture.test/', name: 'fixture', value: 'isolated-login', expirationDate: Date.now() / 1000 + 3600 })
    await session.defaultSession.cookies.flushStore()
    save({ sourceCiphertextHash: hash(readDraft(root)), sourceDatabaseHash: hash(fs.readFileSync(path.join(root, 'settings.db'))) })
  }
  if (mode === 'live' || mode === 'offline') {
    const localState = path.join(source, 'Local State')
    const sourceKeyBefore = fs.existsSync(localState) ? hash(fs.readFileSync(localState)) : undefined
    const result = await core.exportBackup({
      edition, root: () => source, version: () => '0.1.5', deviceId: () => 'isolated-drafts',
      closeDatabases: async () => {}, collect: async () => inventory(source), validate: () => {},
      treeDigest: core.exportTreeDigest,
      verifySources: async before => { for (const [name, expected] of Object.entries(before)) assert.equal(hash(fs.readFileSync(path.join(source, name))), expected) },
    }, archive, { basicData: true, cookies, indexedDB: false, cache: false }, encrypted ? { password } : undefined,
    { strict: offline, expectedDataRoot: source, tempRoot: path.join(base, 'jobs') })
    assert.equal(result.success, true, result.error)
    assert.equal(hash(readDraft(source)), evidence().sourceCiphertextHash)
    assert.equal(hash(fs.readFileSync(path.join(source, 'settings.db'))), evidence().sourceDatabaseHash)
    if (offline) assert.equal(hash(fs.readFileSync(localState)), sourceKeyBefore)
    save({ sourcePreserved: true, edition, encrypted, cookies, offline })
  }
  if (mode === 'restore') {
    let input = archive
    if (encrypted) {
      assert.equal(core.decryptFile(archive, path.join(base, 'wrong.zip'), 'incorrect-password'), null)
      input = path.join(base, 'decrypted.zip')
      assert.ok(core.decryptFile(archive, input, password))
    }
    const zip = new AdmZip(input)
    const manifest = core.validateBackupArchive(zip)
    assert.equal(manifest.sensitiveDrafts.entries[0].state, 'portable')
    assert.deepEqual(manifest.sensitiveDrafts.entries[0].value, value)
    assert.equal(hash(zip.readFile('settings.db')), evidence().sourceDatabaseHash)
    assert.equal(manifest.cookieSnapshots !== undefined, cookies)
    if (!cookies) assert.equal(zip.getEntry('Local State'), null)
    fs.writeFileSync(path.join(root, 'settings.db'), zip.readFile('settings.db'))
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest))
    const original = readDraft(root)
    assert.equal(hash(original), evidence().sourceCiphertextHash)
    assert.throws(() => safeStorage.decryptString(Buffer.from(original, 'base64')))
    const encryptionAvailable = safeStorage.isEncryptionAvailable
    safeStorage.isEncryptionAvailable = () => false
    try { assert.throws(() => core.restoreBackupDrafts(root), /encryption is unavailable/) }
    finally { safeStorage.isEncryptionAvailable = encryptionAvailable }
    assert.equal(readDraft(root), original)
    for (const availableChecks of [1, 3]) {
      let checks = 0
      safeStorage.isEncryptionAvailable = () => ++checks <= availableChecks
      try { assert.throws(() => core.restoreBackupDrafts(root), /encryption is unavailable/) }
      finally { safeStorage.isEncryptionAvailable = encryptionAvailable }
      assert.equal(readDraft(root), original)
    }
    const recovery = new Database(path.join(root, 'settings.db'))
    recovery.prepare('INSERT INTO app_settings VALUES (?,?)').run('windowDraftRecovery:obsolete', JSON.stringify({ ciphertext: original }))
    recovery.close()
    assert.deepEqual(core.restoreBackupDrafts(root), { restored: 0, unavailable: 2 })
    assert.equal(readDraft(root), undefined)
    assert.deepEqual(core.restoreBackupDrafts(root), { restored: 0, unavailable: 0 })
    const discarded = new Database(path.join(root, 'settings.db'))
    assert.equal(discarded.prepare("SELECT count(*) AS count FROM app_settings WHERE key GLOB 'windowDraftRecovery:*'").get().count, 0)
    discarded.prepare('INSERT INTO app_settings VALUES (?,?)').run(key, safeStorage.encryptString('not json').toString('base64'))
    discarded.close()
    assert.deepEqual(core.restoreBackupDrafts(root), { restored: 0, unavailable: 1 })
    assert.equal(readDraft(root), undefined)
    fs.writeFileSync(path.join(root, 'settings.db'), zip.readFile('settings.db'))
    const tampered = structuredClone(manifest.sensitiveDrafts)
    tampered.entries[0].sourceSha256 = '0'.repeat(64)
    assert.throws(() => core.restoreBackupDrafts(root, tampered), /differs from its verified source/)
    assert.equal(readDraft(root), original)
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest))
    assert.deepEqual(core.restoreBackupDrafts(root, manifest.sensitiveDrafts), { restored: 1, unavailable: 0 })
    const rebound = readDraft(root)
    assert.notEqual(rebound, original)
    assert.deepEqual(JSON.parse(safeStorage.decryptString(Buffer.from(rebound, 'base64'))), value)
    assert.deepEqual(core.restoreBackupDrafts(root, manifest.sensitiveDrafts), { restored: 1, unavailable: 0 })
    assert.equal(readDraft(root), rebound)
    const consumed = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    assert.equal(Object.hasOwn(consumed, 'sensitiveDrafts'), false)
    assert.equal(consumed.format, manifest.format)
    assert.deepEqual(consumed.cookieSnapshots, manifest.cookieSnapshots)
    if (cookies) {
      await core.restoreBackupCookies(root, manifest.cookieSnapshots)
      assert.equal((await session.defaultSession.cookies.get({ name: 'fixture' }))[0].value, 'isolated-login')
    }
    save({ targetReencrypted: true, tamperRejected: true, legacyUnavailableDiscarded: true, transientEncryptionPreserved: true, obsoleteRecoveryRemoved: true, targetCiphertextHash: hash(rebound) })
  }
  if (mode === 'cold') {
    const restored = readDraft(root)
    assert.equal(hash(restored), evidence().targetCiphertextHash)
    assert.deepEqual(JSON.parse(safeStorage.decryptString(Buffer.from(restored, 'base64'))), value)
    assert.deepEqual(core.restoreBackupDrafts(root), { restored: 1, unavailable: 0 })
    save({ coldReopenPassed: true, electron: process.versions.electron })
  }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
