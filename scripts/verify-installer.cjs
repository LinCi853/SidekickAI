const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')

const root = path.resolve(__dirname, '..')
const setup = path.resolve(process.argv[2] || '')
if (!fs.existsSync(setup) || !fs.statSync(setup).isFile()) throw new Error('Provide the complete open-source setup executable')
const evidence = fs.mkdtempSync(path.join(root, 'local/installer-verification-'))
const target = path.join(evidence, 'installed')
const appData = path.join(evidence, 'roaming')
const data = path.join(appData, 'sidekickai-opensource')
const token = randomUUID().replaceAll('-', '')
const registry = 'HKCU\\Software\\SidekickAI-OpenSource\\InstallerTests\\' + token
const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: path.join(evidence, 'local'), USERPROFILE: path.join(evidence, 'user'), PUBLIC: path.join(evidence, 'public'), ProgramData: path.join(evidence, 'program-data'), ProgramFiles: path.join(evidence, 'program-files'), SIDEKICK_INSTALL_TEST_REGISTRY: token, SIDEKICK_TEST_SESSION: token }
delete env.ELECTRON_RUN_AS_NODE
const report = { evidence, setup, checks: [], errors: [], operations: [] }
const defaults = { installDir: target, forAllUsers: false, createDesktopShortcut: true, launchAfterInstall: false, features: {}, options: { autoLaunch: false }, mode: 'install', cleanupPaths: [], dataStrategy: 'keep', userDataDir: data }
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(label, changes = {}, executable = setup) {
  const directory = path.join(evidence, 'operations', label)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ ...defaults, ...changes }))
  if (label === 'cancelled') fs.writeFileSync(path.join(directory, 'cancel'), 'cancel')
  const result = spawnSync(executable, ['--elevated', path.join(directory, 'request.json')], { env, windowsHide: true, encoding: 'utf8', timeout: 120000 })
  if (result.error) throw result.error
  const response = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  assert.equal(result.status === 0, response.ok)
  assert(!fs.existsSync(path.join(directory, 'request.json')), 'Sensitive request survived completion')
  report.operations.push({ label, ...response })
  const payload = path.join(directory, 'payload')
  if (fs.existsSync(payload)) fs.rmSync(payload, { recursive: true })
  return response
}
function check(label) { report.checks.push(label); console.log(label) }
function seedData() {
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, 'edition-identity.json'), JSON.stringify({ schema: 1, edition: 'sidekickai-opensource' }))
  const database = new Database(path.join(data, 'settings.db'))
  database.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);')
  database.prepare('INSERT OR REPLACE INTO app_settings VALUES (?,?)').run('fixture', 'preserve')
  database.close()
  fs.writeFileSync(path.join(data, 'sentinel.txt'), 'original user data')
}
async function lock(file) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$f=[IO.File]::Open($env:SIDEKICK_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); [Console]::WriteLine("locked"); [Console]::ReadLine() > $null; $f.Dispose()'], { env: { ...env, SIDEKICK_LOCK_FILE: file }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', chunk => chunk.toString().includes('locked') ? resolve() : reject(new Error('Lock fixture failed'))) })
  return async () => { const exited = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('\n'); await exited }
}
async function main() {
  for (const directory of [appData, env.LOCALAPPDATA, env.USERPROFILE, env.PUBLIC, env.ProgramData, env.ProgramFiles]) fs.mkdirSync(directory, { recursive: true })
  const foreign = path.join(evidence, 'online')
  fs.mkdirSync(foreign)
  fs.writeFileSync(path.join(foreign, 'SidekickAI.exe'), 'online edition sentinel')
  assert.equal(run('foreign-install', { installDir: foreign }).ok, false)
  assert.equal(run('foreign-uninstall', { installDir: foreign, mode: 'uninstall' }).ok, false)
  assert.equal(fs.readFileSync(path.join(foreign, 'SidekickAI.exe'), 'utf8'), 'online edition sentinel')
  check('Foreign edition is preserved for install and uninstall')
  assert.equal(run('cancelled').ok, false)
  assert(!fs.existsSync(target))
  check('Cancellation before commit creates no installation')
  assert.equal(run('profile-install', { installDir: data.toUpperCase() }).ok, false)
  assert(!fs.existsSync(path.join(data, 'SidekickAI-OpenSource.exe')))
  check('Installation cannot overlap its persistent data root')
  const installed = run('install')
  assert(installed.ok, installed.error)
  const owner = JSON.parse(fs.readFileSync(path.join(target, 'sidekick-open-source-install.json')))
  assert.equal(owner.edition, 'sidekickai-opensource')
  const expected = JSON.parse(fs.readFileSync(path.join(target, 'sidekick-open-source-payload.json')))
  for (const [file, digest] of Object.entries(expected.files)) assert.equal(hash(path.join(target, file)), digest, file)
  assert(fs.existsSync(path.join(env.USERPROFILE, 'Desktop', 'SidekickAI-OpenSource.lnk')))
  assert.equal(spawnSync('reg.exe', ['query', registry + '\\user', '/v', 'InstallLocation'], { windowsHide: true }).status, 0)
  check('Fresh per-user installation has all verified runtime files, shortcuts and registration')
  const originalRuntime = hash(path.join(target, 'libEGL.dll'))
  fs.writeFileSync(path.join(target, 'obsolete.dll'), 'old runtime')
  fs.writeFileSync(path.join(target, 'libEGL.dll'), 'damaged')
  let result = run('repair', { mode: 'repair' })
  assert(result.ok, result.error)
  assert.equal(hash(path.join(target, 'libEGL.dll')), originalRuntime)
  assert(!fs.existsSync(path.join(target, 'obsolete.dll')))
  check('Repair replaces damaged full runtime and removes obsolete DLLs')
  const release = await lock(path.join(target, 'libEGL.dll'))
  try { assert.equal(run('locked-repair', { mode: 'repair' }).ok, false) } finally { await release() }
  assert.equal(hash(path.join(target, 'libEGL.dll')), originalRuntime)
  check('A locked runtime rejects replacement and preserves installed bytes')
  fs.writeFileSync(path.join(target, 'portable.txt'), '')
  assert.equal(run('portable-protection', { mode: 'uninstall' }).ok, false)
  fs.unlinkSync(path.join(target, 'portable.txt'))
  check('Portable marker prevents destructive maintenance')
  seedData()
  result = run('keep-uninstall', { mode: 'uninstall', userDataDir: path.join(evidence, 'different-account') })
  assert(result.ok, result.error)
  assert(!fs.existsSync(target))
  assert.equal(fs.readFileSync(path.join(data, 'sentinel.txt'), 'utf8'), 'original user data')
  assert(!fs.existsSync(path.join(env.USERPROFILE, 'Desktop', 'SidekickAI-OpenSource.lnk')))
  assert.notEqual(spawnSync('reg.exe', ['query', registry + '\\user'], { windowsHide: true }).status, 0)
  check('Default uninstall preserves data even across an elevated account change')
  result = run('reinstall')
  assert(result.ok, result.error)
  fs.writeFileSync(path.join(data, 'edition-identity.json'), JSON.stringify({ edition: 'foreign' }))
  assert.equal(run('foreign-data', { mode: 'uninstall', dataStrategy: 'delete' }).ok, false)
  assert(fs.existsSync(path.join(target, 'SidekickAI-OpenSource.exe')))
  fs.writeFileSync(path.join(data, 'edition-identity.json'), JSON.stringify({ schema: 2, edition: 'sidekickai-opensource' }))
  assert.equal(run('unknown-data-schema', { mode: 'uninstall', dataStrategy: 'delete' }).ok, false)
  assert.equal(fs.readFileSync(path.join(data, 'sentinel.txt'), 'utf8'), 'original user data')
  seedData()
  const backup = path.join(evidence, 'verified.zip')
  fs.writeFileSync(backup, 'existing backup')
  assert.equal(run('existing-backup', { mode: 'uninstall', dataStrategy: 'export', backupPath: backup, backupEncrypt: false }).ok, false)
  assert.equal(fs.readFileSync(backup, 'utf8'), 'existing backup')
  fs.unlinkSync(backup)
  check('Foreign data and existing backup refusals retain installation and data')
  const nestedBackup = path.join(data, 'nested-backup.zip').toUpperCase()
  assert.equal(run('nested-backup-case', { mode: 'uninstall', dataStrategy: 'export', backupPath: nestedBackup, backupEncrypt: false }).ok, false)
  assert.equal(fs.readFileSync(path.join(data, 'sentinel.txt'), 'utf8'), 'original user data')
  assert(fs.existsSync(path.join(target, 'SidekickAI-OpenSource.exe')))
  check('Case-varied nested backup paths cannot authorize data removal')
  for (const [label, backupPath] of [
    ['trailing-dot-backup', path.join(data + '.', 'backup.zip')],
    ['trailing-space-backup', path.join(data + ' ', 'backup.zip')],
    ['extended-path-backup', '\\\\?\\' + path.join(data, 'backup.zip')],
  ]) {
    assert.equal(run(label, { mode: 'uninstall', dataStrategy: 'export', backupPath, backupEncrypt: false }).ok, false)
    assert.equal(fs.readFileSync(path.join(data, 'sentinel.txt'), 'utf8'), 'original user data')
    assert(fs.existsSync(path.join(target, 'SidekickAI-OpenSource.exe')))
  }
  check('Win32 path aliases cannot place the only backup inside a removal root')
  for (const journalName of ['.sidekick-open-source-transaction.json', '.sidekick-open-source-uninstall.json']) {
    const journal = path.join(evidence, journalName)
    fs.writeFileSync(journal, 'unresolved recovery fixture')
    for (const mode of ['install', 'repair', 'uninstall']) {
      assert.equal(run('pending-' + journalName + '-' + mode, { mode }).ok, false)
      assert.equal(fs.readFileSync(journal, 'utf8'), 'unresolved recovery fixture')
      assert(fs.existsSync(path.join(target, 'SidekickAI-OpenSource.exe')))
    }
    fs.unlinkSync(journal)
  }
  check('Pending install or uninstall recovery blocks every maintenance mode')
  result = run('export-uninstall', { mode: 'uninstall', dataStrategy: 'export', backupPath: backup, backupEncrypt: false })
  assert(result.ok, result.error)
  assert(!fs.existsSync(target))
  assert(!fs.existsSync(data))
  const archive = new AdmZip(backup)
  assert.equal(archive.readAsText('sentinel.txt'), 'original user data')
  assert(archive.getEntry('settings.db'))
  assert.equal(fs.readFileSync(path.join(foreign, 'SidekickAI.exe'), 'utf8'), 'online edition sentinel')
  check('Actual application export is verified before uninstall removes its own data')
  assert(!fs.existsSync(path.join(evidence, '.sidekick-open-source-uninstall.json')))
  assert(!fs.existsSync(path.join(evidence, '.sidekick-open-source-transaction.json')))
  report.ok = true
}
main().catch(error => { report.ok = false; report.errors.push(error.stack); process.exitCode = 1 }).finally(() => {
  spawnSync('reg.exe', ['delete', registry, '/f'], { windowsHide: true })
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})
