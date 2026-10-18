const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')
const core = require('./core.cjs')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const base = argument('root')
const mode = argument('mode')
const origin = argument('origin')
const edition = argument('edition')
const encrypted = argument('encrypted') === 'true'
const strict = argument('strict') === 'true'
const password = 'isolated-snapshot-password'
const source = base && path.join(base, 'source')
const root = base && (mode === 'restore' ? path.join(base, 'restored') : mode === 'snapshot' ? path.join(base, 'helper') : source)
const archive = base && path.join(base, encrypted ? 'backup.sabackup' : 'backup.zip')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
if (core.cookieHelperRequestPath) core.initializeCookieHelper()
else {
  fs.mkdirSync(root, { recursive: true })
  app.setPath('userData', root)
  app.setPath('sessionData', root)
}

function readEvidence() { return JSON.parse(fs.readFileSync(path.join(base, 'evidence.json'), 'utf8')) }
function writeEvidence(value) { fs.writeFileSync(path.join(base, 'evidence.json'), JSON.stringify(value, null, 2)) }
function inventory(directory, prefix = '') {
  const entries = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name
    const sourcePath = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(...inventory(sourcePath, relative))
    else entries.push({ category: relative.includes('/IndexedDB/') ? 'indexedDB' : relative === 'Local State' || relative.includes('/Cookies') || relative.includes('/Local Storage/') ? 'cookies' : relative.startsWith('plugins/') ? 'plugins' : 'basicData', sourcePath, archivePath: relative })
  }
  return entries
}
async function mutateOriginal() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const args = process.argv.slice(1).map(value => value === '--mode=snapshot' ? '--mode=mutate' : value)
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Resumed fixture timed out: ${output}`)) }, 15000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Resumed fixture failed (${code}): ${output}`)) })
  })
}
async function setBrowserValue(window, value) {
  await window.webContents.executeJavaScript(`localStorage.setItem('fixture', ${JSON.stringify(value)}); new Promise((resolve, reject) => { const request = indexedDB.open('fixture', 1); request.onupgradeneeded = () => request.result.createObjectStore('values'); request.onerror = () => reject(request.error.message); request.onsuccess = () => { const database = request.result; const transaction = database.transaction('values', 'readwrite'); transaction.objectStore('values').put(${JSON.stringify(value)}, 'fixture'); transaction.oncomplete = () => { database.close(); resolve(); }; transaction.onerror = () => reject(transaction.error.message); }; })`)
}
async function readBrowserValue(window) {
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const request = indexedDB.open('fixture', 1); request.onerror = () => reject(request.error.message); request.onsuccess = () => { const database = request.result; const query = database.transaction('values').objectStore('values').get('fixture'); query.onsuccess = () => { database.close(); resolve(query.result); }; query.onerror = () => reject(query.error.message); }; })`)
}

app.whenReady().then(async () => {
  if (core.cookieHelperRequestPath) { app.exit(await core.runCookieSnapshotHelper()); return }
  if (mode === 'snapshot') {
    let callbackCount = 0
    const before = core.exportTreeDigest(source)
    const result = await core.exportBackup({
      edition, root: () => source, version: () => 'fixture', deviceId: () => 'isolated-runtime',
      closeDatabases: async () => {}, collect: async () => inventory(source),
      validate: directory => assert.equal(fs.existsSync(path.join(directory, 'settings.db')), true),
      verifyPayload: core.validateBackupArchive, treeDigest: core.exportTreeDigest,
      verifySources: core.verifyQuiescentSnapshot, writeStrict: core.writeStrictArchive, writeLive: core.writePartialArchive,
    }, archive, { basicData: true, cookies: true, indexedDB: true, cache: true }, encrypted ? { password } : undefined,
    { snapshot: true, strict, expectedDataRoot: source, onSnapshotReady: async () => { callbackCount++; await mutateOriginal() } })
    assert.equal(result.success, true, result.error)
    assert.equal(core.isSabkEncrypted(archive), encrypted)
    assert.equal(core.exportTreeDigest(source) === before, strict)
    assert.equal(callbackCount, strict ? 0 : 1)
    if (encrypted) {
      const wrong = path.join(base, 'wrong-password.zip')
      assert.equal(core.decryptFile(archive, wrong, 'incorrect-password'), null)
      assert.equal(fs.existsSync(wrong), false)
    }
    const seed = JSON.parse(fs.readFileSync(path.join(base, 'seed.json'), 'utf8'))
    writeEvidence({ edition, encrypted, strict, callbackCount, continuousWrites: seed.writes, sourceChangedAfterSnapshot: !strict, entries: Object.keys(result.sourceEntries).length, electron: process.versions.electron })
    app.quit()
    return
  }
  if (mode === 'restore') {
    let input = archive
    if (encrypted) { input = path.join(base, 'decrypted.zip'); assert.ok(core.decryptFile(archive, input, password)) }
    const manifest = core.extractBackupArchive(new AdmZip(input), root)
    assert.equal(manifest.edition, edition)
    await core.restoreBackupCookies(root, manifest.cookieSnapshots)
  }
  const target = session.fromPartition('persist:continuous')
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:continuous', backgroundThrottling: false } })
  await window.loadURL(origin)
  if (mode === 'seed' || mode === 'mutate') {
    const value = mode === 'seed' ? 'snapshot value' : 'resumed value'
    const database = new Database(path.join(root, 'settings.db'))
    database.exec('CREATE TABLE IF NOT EXISTS fixture (value TEXT)')
    database.exec('DELETE FROM fixture')
    database.prepare('INSERT INTO fixture VALUES (?)').run(value)
    database.close()
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(root, 'plugins/fixture.json'), JSON.stringify({ value }))
    if (mode === 'seed') {
      await window.webContents.executeJavaScript(`window.fixtureWrites = 0; window.fixtureTimer = setInterval(() => { localStorage.setItem('continuous', String(++window.fixtureWrites)); }, 10)`)
      for (let index = 0; index < 15; index++) { await setBrowserValue(window, `continuous-${index}`); await sleep(20) }
      const writes = await window.webContents.executeJavaScript('clearInterval(window.fixtureTimer); window.fixtureWrites')
      assert.ok(writes > 0)
      fs.writeFileSync(path.join(base, 'seed.json'), JSON.stringify({ writes }))
    }
    await setBrowserValue(window, value)
    await target.cookies.set({ url: origin, name: 'fixture', value, expirationDate: Date.now() / 1000 + 3600 })
    await target.cookies.flushStore()
    target.flushStorageData()
    await sleep(250)
  } else {
    const expected = mode === 'restore' || strict ? 'snapshot value' : 'resumed value'
    const database = new Database(path.join(root, 'settings.db'), { readonly: true, fileMustExist: true })
    assert.equal(database.prepare('SELECT value FROM fixture').get().value, expected)
    database.close()
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plugins/fixture.json'), 'utf8')).value, expected)
    assert.equal(await window.webContents.executeJavaScript('localStorage.getItem("fixture")'), expected)
    assert.equal(await readBrowserValue(window), expected)
    assert.equal((await target.cookies.get({ name: 'fixture' }))[0].value, expected)
    const evidence = readEvidence()
    if (mode === 'restore') Object.assign(evidence, { restoredValue: expected, cookieRestored: true, indexedDbRestored: true })
    else evidence.sourceValue = expected
    writeEvidence(evidence)
  }
  window.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
