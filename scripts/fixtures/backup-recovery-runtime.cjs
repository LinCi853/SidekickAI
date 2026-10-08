const { app, BrowserWindow, session, dialog } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')
const core = require('./core.cjs')
const base = process.env.BACKUP_FIXTURE_BASE
const origin = process.env.BACKUP_FIXTURE_ORIGIN
app.commandLine.appendSwitch('explicitly-allowed-ports', new URL(origin).port)
const source = path.join(base, 'source')
const target = path.join(base, 'recovered.sabackup')
const password = 'isolated-lifecycle-secret-5739'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const resultIndex = process.argv.indexOf('--backup-snapshot-result')
const requestFile = resultIndex < 0 ? undefined : process.argv[resultIndex + 1]
const workerCrash = process.env.BACKUP_FIXTURE_WORKER_CRASH === 'true'
const cancel = process.env.BACKUP_FIXTURE_CANCEL === 'true'
const replaceRoot = process.env.BACKUP_FIXTURE_REPLACE_ROOT === 'true'
const launchArgument = process.env.BACKUP_FIXTURE_LAUNCH_ARGUMENT
let resultDialog
dialog.showMessageBox = async options => { resultDialog = options; return { response: 0, checkboxChecked: false } }
dialog.showErrorBox = (title, content) => {
  const expectedBoundary = replaceRoot && content.includes('备份源目录已被替换')
  fs.writeFileSync(path.join(base, expectedBoundary ? 'boundary-dialog.json' : 'failure.json'), JSON.stringify({ title, content }))
}
if (core.backupGuardianRequest) core.initializeBackupGuardian()
else if (core.cookieHelperRequestPath) core.initializeCookieHelper()
else if (core.backupWorkerRequest) core.initializeBackupWorker()
else {
  fs.mkdirSync(source, { recursive: true })
  const browserRoot = replaceRoot ? path.join(base, 'browser') : source
  fs.mkdirSync(browserRoot, { recursive: true })
  app.setPath('userData', browserRoot)
  app.setPath('sessionData', browserRoot)
}
let browser
let inventories = 0
let settingsWriter
const workerLaunches = () => fs.readFileSync(path.join(base, 'worker-launches.txt'), 'utf8').trim().split('\n').length

function inventory(directory, prefix = '') {
  const entries = []
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name
    const sourcePath = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(...inventory(sourcePath, relative))
    else if (relative === 'settings.db' || relative.includes('/Local Storage/') || relative.includes('/IndexedDB/')) entries.push({ category: relative === 'settings.db' ? 'basicData' : 'indexedDB', sourcePath, archivePath: relative })
  }
  return entries
}
const exportData = (output, options, encrypt, preparation) => core.exportBackup({
  edition: 'community', root: () => core.backupSourceRoot() || source, version: () => 'fixture', deviceId: () => 'isolated-lifecycle',
  validate: () => {}, verifyPayload: core.validateBackupArchive, closeDatabases: async () => {},
  collect: async () => {
    if (!preparation?.snapshot && ++inventories > 1) { await sleep(500); session.fromPartition('persist:continuous').flushStorageData(); await sleep(250) }
    return inventory(source)
  },
  verifySources: core.verifyQuiescentSnapshot, treeDigest: core.exportTreeDigest,
  writeStrict: core.writeStrictArchive, writeLive: core.writePartialArchive,
}, output, options, encrypt, preparation)

function saveSettings(value) {
  const database = new Database(path.join(source, 'settings.db'))
  database.exec('CREATE TABLE IF NOT EXISTS fixture (value TEXT); DELETE FROM fixture')
  database.prepare('INSERT INTO fixture VALUES (?)').run(value)
  database.close()
}
async function openBrowser() {
  browser = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:continuous', backgroundThrottling: false } })
  await browser.loadURL(origin)
}

app.whenReady().then(async () => {
  if (core.backupGuardianRequest) { fs.writeFileSync(path.join(base, 'guardian-pid.txt'), String(process.pid)); const status = await core.runBackupGuardian(); if (process.env.BACKUP_FIXTURE_GUARDIAN_DELAY === 'true') await sleep(1500); app.exit(status); return }
  if (core.cookieHelperRequestPath) { app.exit(await core.runCookieSnapshotHelper()); return }
  if (core.backupWorkerRequest) {
    fs.appendFileSync(path.join(base, 'worker-launches.txt'), `${process.pid}\n`)
    fs.writeFileSync(path.join(base, 'request-path.txt'), core.backupWorkerRequest)
    const publicRequest = fs.readFileSync(core.backupWorkerRequest)
    const requestContainsPassword = publicRequest.includes(Buffer.from(password))
    assert.equal(requestContainsPassword, false)
    assert.equal(JSON.parse(publicRequest.toString('utf8')).encrypt, undefined)
    const status = await core.runBackupWorker(async () => { if (workerCrash) process.exit(73); return { export: exportData } })
    fs.writeFileSync(path.join(base, 'worker-complete.json'), JSON.stringify({ status, requestContainsPassword }))
    if (replaceRoot) {
      assert.equal(status, 1)
      const database = new Database(path.join(base, 'source-original/settings.db'), { readonly: true })
      const sourceValue = database.prepare('SELECT value FROM fixture').get().value
      database.close()
      fs.writeFileSync(path.join(base, 'finished.json'), JSON.stringify({ requestContainsPassword: fs.readFileSync(core.backupWorkerRequest).includes(Buffer.from(password)), workerLaunches: workerLaunches(), archivePublished: fs.existsSync(target), resumed: fs.existsSync(path.join(base, 'resumed-launches.txt')), sourceValue, cancelledWhileOriginalAlive: false, replacementUntouched: fs.readdirSync(source).length === 1 && fs.readFileSync(path.join(source, 'replacement.txt'), 'utf8') === 'unrelated replacement', status: JSON.parse(fs.readFileSync(path.join(path.dirname(core.backupWorkerRequest), 'status.json'), 'utf8')) }, null, 2))
    }
    app.exit(status === 1 && (cancel || replaceRoot) ? 0 : status)
    return
  }
  if (requestFile) {
    fs.appendFileSync(path.join(base, 'resumed-launches.txt'), `${process.pid}\n`)
    assert.equal(cancel || replaceRoot, false, 'Unexpected application restart')
    const requestContainsPassword = fs.readFileSync(requestFile).includes(Buffer.from(password))
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
    assert.equal(request.encrypt, undefined)
    let windowStateRestored = false
    await core.finishBackupRecovery(async state => {
      assert.deepEqual(state, { views: [{ id: 'fixture-window', url: origin }] })
      await openBrowser()
      saveSettings('resumed value')
      await browser.webContents.executeJavaScript('localStorage.setItem("fixture", "resumed value")')
      windowStateRestored = true
      if (process.env.BACKUP_FIXTURE_WINDOW_FAILURE === 'true') throw new Error('fixture window restore error')
    }, () => source)
    if (workerCrash) {
      assert.equal(resultDialog?.type, 'error');
      fs.writeFileSync(path.join(base, 'finished.json'), JSON.stringify({ requestContainsPassword, workerLaunches: workerLaunches(), windowStateRestored, archivePublished: fs.existsSync(target), recoveredAfterCrash: true, dialog: resultDialog }));
      browser.destroy(); app.quit(); return;
    }
    assert.equal(resultDialog?.type, 'info', JSON.stringify(resultDialog))
    const decrypted = path.join(base, 'verified.zip')
    assert.equal(core.decryptFile(target, decrypted, password), 'isolated-lifecycle')
    const zip = new AdmZip(decrypted)
    core.validateBackupArchive(zip)
    const restored = path.join(base, 'restored')
    fs.mkdirSync(restored)
    core.extractBackupArchive(zip, restored)
    const restoredDb = new Database(path.join(restored, 'settings.db'), { readonly: true })
    const archiveValue = restoredDb.prepare('SELECT value FROM fixture').get().value
    restoredDb.close()
    const originalDb = new Database(path.join(source, 'settings.db'), { readonly: true })
    const sourceValue = originalDb.prepare('SELECT value FROM fixture').get().value
    originalDb.close()
    const staging = process.env.SIDEKICK_BACKUP_JOB_ROOT
    const retainedTasks = fs.existsSync(staging) ? fs.readdirSync(staging).filter(name => /^[0-9a-f-]{36}$/i.test(name)).length : 0
    fs.writeFileSync(path.join(base, 'finished.json'), JSON.stringify({ windowStateRestored, requestContainsPassword, archiveVerified: true, archiveValue, sourceValue, retainedTasks, dialog: resultDialog, workerLaunches: workerLaunches(), guardianStopped: (() => { try { process.kill(Number(fs.readFileSync(path.join(base, 'guardian-pid.txt'), 'utf8')), 0); return false } catch { return true } })(), requestRemoved: !fs.existsSync(requestFile), transientArgumentReplayed: process.argv.some(value => ['--sidekick-admin-task', '--sidekick-normal-handoff'].includes(value)), initialLaunchArgument: launchArgument || null, electron: process.versions.electron }, null, 2))
    browser.destroy()
    app.quit()
    return
  }
  saveSettings('before save')
  if (launchArgument) assert.equal(process.argv.includes(launchArgument), true)
  await openBrowser()
  await browser.webContents.executeJavaScript('window.fixtureCount=0; window.fixtureTimer=setInterval(()=>localStorage.setItem("fixture",String(++window.fixtureCount)),10)')
  if (replaceRoot) settingsWriter = setInterval(() => saveSettings(`continuous-${Date.now()}`), 20)
  await sleep(750)
  session.fromPartition('persist:continuous').flushStorageData()
  await sleep(250)
  const response = await core.exportWithRecovery({
    source: () => source, export: exportData, captureWindows: () => ({ views: [{ id: 'fixture-window', url: origin }] }),
    quit: async beforeQuit => {
      await browser.webContents.executeJavaScript('clearInterval(window.fixtureTimer); localStorage.setItem("fixture", "saved before quit")')
      clearInterval(settingsWriter)
      saveSettings('saved before quit')
      session.fromPartition('persist:continuous').flushStorageData()
      await sleep(100)
      await beforeQuit()
      if (cancel) return false
      browser.destroy()
      if (replaceRoot) {
        assert.equal(path.dirname(source), base)
        const preserved = path.join(base, 'source-original')
        assert.equal(path.dirname(preserved), base)
        fs.renameSync(source, preserved)
        fs.mkdirSync(source)
        fs.writeFileSync(path.join(source, 'replacement.txt'), 'unrelated replacement')
      }
      app.quit()
      return true
    },
  }, target, { basicData: true, cookies: false, indexedDB: true, cache: false }, { password }, process.env.BACKUP_FIXTURE_CLEANUP === 'true' ? { cleanup: true } : undefined)
  if (cancel) {
    assert.match(response.error, /取消/)
    const deadline = Date.now() + 10000
    while (!fs.existsSync(path.join(base, 'worker-complete.json'))) {
      if (Date.now() > deadline) throw new Error('Cancelled worker did not stop')
      await sleep(100)
    }
    const request = fs.readFileSync(path.join(base, 'request-path.txt'), 'utf8')
    const database = new Database(path.join(source, 'settings.db'), { readonly: true })
    const sourceValue = database.prepare('SELECT value FROM fixture').get().value
    database.close()
    const originalAlive = !browser.isDestroyed() && await browser.webContents.executeJavaScript('localStorage.getItem("fixture")') === 'saved before quit'
    const workerResult = JSON.parse(fs.readFileSync(path.join(base, 'worker-complete.json'), 'utf8'))
    fs.writeFileSync(path.join(base, 'finished.json'), JSON.stringify({ requestContainsPassword: workerResult.requestContainsPassword, workerLaunches: workerLaunches(), archivePublished: fs.existsSync(target), resumed: fs.existsSync(path.join(base, 'resumed-launches.txt')), sourceValue, cancelledWhileOriginalAlive: originalAlive, replacementUntouched: false, status: workerResult.status, cancellationError: response.error, requestRemoved: !fs.existsSync(request), jobRemoved: !fs.existsSync(path.dirname(request)) }, null, 2))
    browser.destroy()
    app.quit()
  } else assert.match(response.error, /后台继续/)
}).catch(error => { fs.writeFileSync(path.join(base, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack })); console.error(error); app.exit(1) })
