const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

const scenarios = [
  { name: 'releases transient application staging after verified publication', id: 'transient-cleanup', cleanup: true },
  { name: 'after the guardian releases its session files', id: 'guardian-delay', guardianDelay: true },
  { name: 'after an abrupt snapshot worker exit', id: 'worker-crash', workerCrash: true },
  { name: 'without storing the password', id: 'lifecycle' },
  { name: 'despite a window restoration error', id: 'window-failure', windowFailure: true },
  { name: 'without replaying the administrator launch argument', id: 'admin-argument', launchArgument: '--sidekick-admin-task' },
  { name: 'without replaying the normal handoff argument', id: 'normal-argument', launchArgument: '--sidekick-normal-handoff' },
  { name: 'without exporting or restarting after a committed quit is declined', id: 'cancel', cancel: true },
  { name: 'without reading or restarting a replacement data root', id: 'replaced-root', replaceRoot: true },
]
for (const scenario of scenarios) test(`production recovery ${scenario.name}`, { timeout: 90000 }, async () => {
  const workspace = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-recovery-runtime-'))
  const server = http.createServer((_request, response) => response.end('<!doctype html><title>Isolated recovery fixture</title>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let finished = false
  try {
    for (const name of ['better-sqlite3', 'adm-zip']) {
      const moduleDirectory = path.join(directory, 'node_modules', name)
      fs.mkdirSync(moduleDirectory, { recursive: true })
      fs.writeFileSync(path.join(moduleDirectory, 'index.js'), `module.exports = require(${JSON.stringify(require.resolve(name))})`)
    }
    await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'adm-zip'], logLevel: 'silent',
      stdin: { contents: `export * from './packages/backup-core/export'; export * from './packages/backup-core/files'; export * from './packages/backup-core/format'; export * from './packages/backup-core/file-crypto'; export * from './packages/backup-core/sessions'; export * from './packages/backup-core/recovery'; export * from './packages/backup-core/guardian'; export * from './packages/backup-core/context'; export { verifyQuiescentSnapshot } from './electron/store/backup/verify';`, resolveDir: workspace },
      outfile: path.join(directory, 'core.cjs') })
    fs.copyFileSync(path.join(__dirname, 'fixtures/backup-recovery-runtime.cjs'), path.join(directory, 'runtime.cjs'))
    const env = { ...process.env, SIDEKICK_BACKUP_JOB_ROOT: path.join(directory, 'durable-jobs'), BACKUP_FIXTURE_BASE: directory, BACKUP_FIXTURE_GUARDIAN_DELAY: String(!!scenario.guardianDelay), BACKUP_FIXTURE_WORKER_CRASH: String(!!scenario.workerCrash), BACKUP_FIXTURE_ORIGIN: `http://127.0.0.1:${server.address().port}`, BACKUP_FIXTURE_WINDOW_FAILURE: String(!!scenario.windowFailure), BACKUP_FIXTURE_CANCEL: String(!!scenario.cancel), BACKUP_FIXTURE_REPLACE_ROOT: String(!!scenario.replaceRoot), BACKUP_FIXTURE_LAUNCH_ARGUMENT: scenario.launchArgument || '' }
    env.BACKUP_FIXTURE_CLEANUP = String(!!scenario.cleanup)
    delete env.ELECTRON_RUN_AS_NODE
    const output = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(directory, 'runtime.cjs'), '--disable-gpu', '--disable-crashpad', ...(scenario.launchArgument ? [scenario.launchArgument] : [])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let captured = ''
      child.stdout.on('data', value => { captured += value })
      child.stderr.on('data', value => { captured += value })
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Initial application timed out: ${captured}`)) }, 25000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(captured) : reject(new Error(`Initial application failed (${code}): ${captured}`)) })
    })
    const deadline = Date.now() + 50000
    while (!fs.existsSync(path.join(directory, 'finished.json'))) {
      if (fs.existsSync(path.join(directory, 'failure.json'))) throw new Error(fs.readFileSync(path.join(directory, 'failure.json'), 'utf8'))
      if (Date.now() > deadline) throw new Error(`Recovery timed out: ${output}; files: ${fs.readdirSync(directory).join(', ')}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'finished.json'), 'utf8'))
    assert.equal(result.requestContainsPassword, false)
    assert.equal(result.workerLaunches, 1)
    if (scenario.workerCrash) {
      assert.equal(result.recoveredAfterCrash, true)
      assert.equal(result.windowStateRestored, true)
      assert.equal(result.archivePublished, false)
      assert.equal(result.dialog.type, 'error')
    } else if (scenario.cancel || scenario.replaceRoot) {
      assert.equal(result.archivePublished, false)
      assert.equal(result.resumed, false)
      assert.equal(result.sourceValue, 'saved before quit')
      assert.equal(result.cancelledWhileOriginalAlive, !!scenario.cancel)
      assert.equal(result.replacementUntouched, !!scenario.replaceRoot)
      if (scenario.cancel) {
        assert.equal(result.status, 1)
        assert.equal(result.requestRemoved, true)
        assert.equal(result.jobRemoved, true)
      }
    } else {
      assert.equal(result.windowStateRestored, true)
      assert.equal(result.archiveVerified, true)
      assert.equal(result.sourceValue, 'resumed value')
      assert.equal(result.archiveValue, 'saved before quit')
      if (scenario.cleanup) assert.equal(result.retainedTasks, 0)
      assert.equal(result.dialog.type, 'info')
      assert.equal(result.dialog.detail.includes('fixture window restore error'), !!scenario.windowFailure)
      assert.equal(result.requestRemoved, true)
      if (scenario.guardianDelay) assert.equal(result.guardianStopped, true)
      assert.equal(result.transientArgumentReplayed, false)
    }
    const evidence = path.join(workspace, scenario.cleanup ? 'local/development/2026-10-07-backup-simplification/runtime' : 'local/development/2026-10-07-reliable-lifecycle/runtime')
    if (fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, `recovery-${scenario.id}.json`), JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'Production recovery helper, inherited IPC channel, spawn and public core; isolated save/window adapter.', ...result }, null, 2))
    finished = true
  } finally {
    server.close()
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.equal(path.basename(directory).startsWith('sidekick-recovery-runtime-'), true)
    if (finished) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    else console.error(`Isolated recovery evidence retained: ${directory}`)
  }
})
