const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

async function main() {
  const workspace = path.resolve(__dirname, '..')
  fs.mkdirSync(path.join(workspace, 'local'), { recursive: true })
  const root = fs.mkdtempSync(path.join(workspace, 'local', 'edition-quit-'))
  const bundle = path.join(root, 'fixture.cjs')
  const sessionBundle = path.join(root, 'session.cjs')
  await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures', 'edition-quit.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle })
  await esbuild.build({ entryPoints: [path.join(workspace, 'electron', 'edition-session.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: sessionBundle })
  const { editionSessionEndpoint, requestEdition } = require(sessionBundle)
  const namespace = 'quit-fixture-' + randomUUID()
  const endpoint = editionSessionEndpoint(namespace)
  const log = fs.openSync(path.join(root, 'electron.log'), 'w')
  const env = { ...process.env, SIDEKICK_TEST_SESSION: namespace, SIDEKICK_EDITION_FIXTURE_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [bundle], { cwd: workspace, env, stdio: ['ignore', log, log, 'ipc'] })
  fs.closeSync(log)
  const events = []
  const waiters = []
  let exited = false
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) }))
  child.on('message', message => {
    events.push(message)
    for (const waiter of [...waiters]) if (waiter.predicate(message)) waiter.resolve(message)
  })
  const waitEvent = (predicate, timeoutMs = 15000) => {
    const existing = events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Fixture event timed out')) }, timeoutMs)
      const waiter = { predicate, resolve: value => { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(value) } }
      waiters.push(waiter)
    })
  }
  const send = (action = 'status') => requestEdition(endpoint, { protocol: 1, edition: 'online', action })
  const report = { root, namespace, events, statuses: [], passed: false }
  let failure
  try {
    await waitEvent(message => message.event === 'ready')
    report.statuses.push(await send('activate'))
    assert.equal(report.statuses[0].status, 'yielding')
    const veto = await waitEvent(message => message.event === 'veto')
    assert.equal(veto.defaultPrevented, false, 'The fixture must not override beforeunload')
    const deadline = Date.now() + 2000
    do {
      const reply = await send()
      report.statuses.push(reply)
      if (reply.status !== 'yielding') break
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    assert.equal(report.statuses.at(-1).status, 'busy', 'A confirmed veto must stop yielding')
    assert.equal(exited, false, 'The veto must leave the owner alive')
    child.send({ action: 'allow' })
    await waitEvent(message => message.event === 'allowed')
    report.statuses.push(await send('activate'))
    assert.equal(report.statuses.at(-1).status, 'yielding')
    await waitEvent(message => message.event === 'will-quit')
    report.exit = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 10000).unref())])
    assert.ok(report.exit, 'The isolated owner did not actually exit')
    assert.equal(report.exit.code, 0)
    assert.equal(events.filter(message => message.event === 'before-quit').length, 2)
    report.passed = true
  } catch (error) {
    failure = error
    report.error = String(error)
  } finally {
    if (!exited && child.connected) {
      child.send({ action: 'cleanup' })
      const cleanup = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 10000).unref())])
      report.cleanup = cleanup || 'Fixture did not exit after removing its own veto; no forced termination was attempted'
      if (!cleanup) { child.disconnect(); child.unref() }
    }
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ root, passed: report.passed, error: report.error, cleanup: report.cleanup }, null, 2))
  }
  if (failure) throw failure
}
main().catch(error => { console.error(error); process.exitCode = 1 })
