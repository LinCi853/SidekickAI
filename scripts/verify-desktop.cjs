const { _electron: electron } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')

const root = path.resolve(__dirname, '..')
const local = path.join(root, 'local')
fs.mkdirSync(local, { recursive: true })
const evidence = fs.mkdtempSync(path.join(local, 'desktop-verification-'))
const bootstrap = path.join(evidence, 'bootstrap.cjs')
const sourceProfile = path.join(evidence, 'source')
const destinationProfile = path.join(evidence, 'destination')
const backup = path.join(evidence, 'backup.sabackup')
const password = 'disposable-verification-password'
const content = 'A local note saved immediately before quitting.'
const report = { checks: [], pageErrors: [], blockedRequests: [], uncaught: [] }
let activeApp

fs.writeFileSync(bootstrap, `
const { app } = require('electron');
const fs = require('node:fs');
app.setAppPath(${JSON.stringify(root)});
app.setLoginItemSettings = () => {};
app.relaunch = () => fs.writeFileSync(process.env.VERIFY_RELAUNCH_FILE, 'requested');
process.on('uncaughtException', error => {
  fs.appendFileSync(process.env.VERIFY_EXCEPTION_FILE, error.stack + '\\n');
  app.exit(1);
});
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    fs.appendFileSync(process.env.VERIFY_REQUEST_FILE, request.url + '\\n');
    callback({ cancel: true });
  });
});
require(${JSON.stringify(path.join(root, 'out/main/index.cjs'))});
`)

async function launch(profile, label) {
  const env = {
    ...process.env,
    SIDEKICK_DATA_DIR: profile,
    VERIFY_RELAUNCH_FILE: path.join(evidence, `${label}-relaunch.txt`),
    VERIFY_EXCEPTION_FILE: path.join(evidence, `${label}-exception.log`),
    VERIFY_REQUEST_FILE: path.join(evidence, 'blocked-requests.log'),
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'LIB', 'LIBPATH']) delete env[key]
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [bootstrap, '--skip-guide'],
    cwd: root,
    env,
    timeout: 30000,
  })
  activeApp = app
  const log = fs.createWriteStream(path.join(evidence, `${label}.log`))
  app.process().stdout.on('data', data => log.write(data))
  app.process().stderr.on('data', data => log.write(data))
  app.on('window', page => page.on('pageerror', error => report.pageErrors.push(error.message)))
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.electron && document.body.innerText.length > 50)
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile)
  return { app, page }
}

async function close(app) {
  await app.close()
  activeApp = null
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

async function openAdvanced(app, page) {
  const opened = app.waitForEvent('window')
  await page.evaluate(() => window.electron.openAdvancedPanelWindow())
  const advanced = await opened
  await advanced.waitForFunction(() => document.body.innerText.includes('灵感笔记'))
  return advanced
}

async function readRecords(page, boardId) {
  return page.evaluate(async id => ({
    notes: await window.electron.notes.list(),
    prompts: await window.electron.prompt.list(),
    board: await window.electron.whiteboard.getSnapshot(id),
    settings: await window.electron.appSettings.get(),
  }), boardId)
}

function assertRecords(records) {
  assert.equal(records.notes.find(note => note.id === 'verification-note')?.content, content)
  assert(records.prompts.some(prompt => prompt.id === 'verification-prompt'))
  assert(JSON.parse(records.board).elements.some(element => element.type === 'rectangle'))
  assert.equal(records.settings.notesSidebarWidth, 203)
}

async function verify() {
  let { app, page } = await launch(sourceProfile, 'source-write')
  const navigation = await page.evaluate(async () => {
    const api = window.electron
    if ((await api.modules.list()).find(module => module.id === 'browser')?.enabled) {
      throw new Error('The browser module must start disabled in a fresh profile')
    }
    const entry = { id: 'verification-history', url: 'https://example.invalid/local', title: 'Local history', timestamp: 1 }
    await api.navHistory.record('verification-profile', entry)
    for (const enabled of [true, false]) {
      const result = await api.modules.setEnabled('browser', enabled)
      if (!result.ok) throw new Error(result.error)
    }
    const cleared = await api.modules.clearData('browser')
    if (!cleared.ok) throw new Error(cleared.error)
    return api.navHistory.get('verification-profile')
  })
  assert(navigation.some(entry => entry.url === 'https://example.invalid/local' && entry.title === 'Local history'))
  report.checks.push('main navigation survives browser enable, disable and data clearing')
  const board = await page.evaluate(async () => {
    const api = window.electron
    const note = await api.notes.save({ id: 'verification-note', title: 'Offline verification', content: 'Initial draft' })
    await api.notes.setActive(note.id)
    const board = await api.whiteboard.create('Offline drawing')
    await api.whiteboard.setActive(board.id)
    await api.prompt.save({ id: 'verification-prompt', title: 'Offline prompt', content: 'A local prompt', createdAt: 1, updatedAt: 1 })
    await api.appSettings.update({ notesSidebarWidth: 203 })
    return board
  })
  let advanced = await openAdvanced(app, page)
  await advanced.getByText('白板', { exact: true }).first().click()
  const canvas = advanced.locator('canvas').last()
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } })
  await advanced.keyboard.press('r')
  await advanced.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await advanced.mouse.down()
  await advanced.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 5 })
  await advanced.mouse.up()
  await waitUntil(() => page.evaluate(async id => {
    const value = await window.electron.whiteboard.getSnapshot(id)
    return value && JSON.parse(value).elements?.some(element => element.type === 'rectangle')
  }, board.id), 'The whiteboard did not save the drawing')
  await advanced.screenshot({ path: path.join(evidence, 'whiteboard.png') })
  await advanced.getByText('灵感笔记', { exact: true }).first().click()
  await advanced.locator('textarea').first().fill(content)
  await close(app)
  report.checks.push('offline drawing and immediate note shutdown')

  ;({ app, page } = await launch(sourceProfile, 'source-restart'))
  assertRecords(await readRecords(page, board.id))
  report.checks.push('notes, whiteboard, prompts and settings survive restart')
  report.assets = await page.evaluate(async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/V5kAAAAASUVORK5CYII='
    return { note: await window.electron.notes.saveImage(png), board: await window.electron.whiteboard.saveImage(png) }
  })
  const exported = await page.evaluate(async input => window.electron.appSettings.exportData(input.backup,
    { basicData: true, cookies: false, indexedDB: false, cache: false, voiceAssets: false }, { password: input.password }), { backup, password })
  assert(exported.success, exported.error)
  assertRecords(await readRecords(page, board.id))
  report.checks.push('encrypted export leaves live stores usable')
  const wrongPassword = await page.evaluate(file => window.electron.appSettings.importDataDecrypted(file, 'incorrect-password'), backup)
  assert.equal(wrongPassword.success, false)
  assertRecords(await readRecords(page, board.id))
  const invalid = path.join(evidence, 'corrupt.zip')
  const zip = new AdmZip()
  zip.addFile('settings.db', Buffer.from('not a SQLite database'))
  zip.writeZip(invalid)
  const rejected = await page.evaluate(file => window.electron.appSettings.importData(file), invalid)
  assert.equal(rejected.success, false)
  assertRecords(await readRecords(page, board.id))
  report.checks.push('corrupt archives and incorrect passwords preserve current data')
  await close(app)

  ;({ app, page } = await launch(destinationProfile, 'restore'))
  await page.evaluate(() => window.electron.notes.save({ id: 'destination-record', content: 'Original destination record' }))
  const closed = app.waitForEvent('close', { timeout: 10000 })
  const response = await app.evaluate(async ({ ipcMain, BrowserWindow }, input) => {
    return ipcMain._invokeHandlers.get('app:importDataDecrypted')(
      { sender: BrowserWindow.getAllWindows()[0].webContents }, input.backup, input.password)
  }, { backup, password })
  assert(response.success, response.error)
  await closed
  activeApp = null
  assert(fs.existsSync(path.join(evidence, 'restore-relaunch.txt')))
  ;({ app, page } = await launch(destinationProfile, 'restored-restart'))
  assertRecords(await readRecords(page, board.id))
  advanced = await openAdvanced(app, page)
  await advanced.getByText('灵感笔记', { exact: true }).first().click()
  await advanced.screenshot({ path: path.join(evidence, 'restored-note.png') })
  await close(app)
  report.checks.push('encrypted restore, automatic exit and restored profile startup')

  for (const directory of ['notes-assets', 'whiteboard-assets']) {
    for (const file of fs.readdirSync(path.join(sourceProfile, directory))) {
      assert.deepEqual(fs.readFileSync(path.join(sourceProfile, directory, file)), fs.readFileSync(path.join(destinationProfile, directory, file)))
    }
  }
  for (const file of fs.readdirSync(destinationProfile).filter(file => file.endsWith('.db'))) {
    const db = new Database(path.join(destinationProfile, file), { readonly: true })
    try { assert.equal(db.pragma('integrity_check', { simple: true }), 'ok') }
    finally { db.close() }
  }
  report.checks.push('restored assets match and all restored databases pass integrity checks')
}

verify().then(() => { report.ok = true }).catch(error => {
  report.ok = false
  report.error = error.stack
  process.exitCode = 1
}).finally(async () => {
  if (activeApp) await activeApp.close().catch(() => {})
  for (const file of fs.readdirSync(evidence).filter(file => file.endsWith('-exception.log'))) {
    report.uncaught.push(fs.readFileSync(path.join(evidence, file), 'utf8'))
  }
  const requests = path.join(evidence, 'blocked-requests.log')
  if (fs.existsSync(requests)) report.blockedRequests = [...new Set(fs.readFileSync(requests, 'utf8').trim().split('\n'))]
  if (report.pageErrors.length || report.uncaught.length) { report.ok = false; process.exitCode = 1 }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, evidence }, null, 2))
})
