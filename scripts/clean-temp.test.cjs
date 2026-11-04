'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { matches, collect, isWorkerDir } = require('./clean-temp.cjs')

const script = path.join(__dirname, 'clean-temp.cjs')

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-clean-temp-selftest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function age(target, hours) {
  const when = new Date(Date.now() - hours * 3600 * 1000)
  fs.utimesSync(target, when, when)
}

test('matches only managed prefixes', () => {
  assert.ok(matches('SidekickAI-Extract-abc'))
  assert.ok(matches('sidekickai-asset-xyz'))
  assert.ok(matches('sidekick-normal-install-acquired-resources-1'))
  assert.ok(matches('electron-download-Tt21QI'))
  assert.ok(matches('ai-window-stt-local-1.wav'))
  assert.ok(!matches('dsh-workspace-changes-abc'))
  assert.ok(!matches('607a2749-1847-41a5-8ba1-d73c8fe5255b.tmp'))
  assert.ok(!matches('Chrome'))
})

test('isWorkerDir covers the production uninstall root', () => {
  assert.ok(isWorkerDir('SidekickAI-Uninstall'))
  assert.ok(isWorkerDir('SidekickAI-Uninstall-test-hash'))
  assert.ok(!isWorkerDir('SidekickAI-Extract-hash'))
})

test('collect lists managed entries and skips the rest', t => {
  const root = makeTempRoot(t)
  fs.mkdirSync(path.join(root, 'SidekickAI-Extract-old'))
  fs.mkdirSync(path.join(root, 'sidekickai-asset-a'))
  fs.mkdirSync(path.join(root, 'unrelated-app'))
  const names = collect(root).map(entry => entry.name).sort()
  assert.deepEqual(names, ['SidekickAI-Extract-old', 'sidekickai-asset-a'])
})

test('CLI removes stale managed entries and keeps recent ones', t => {
  const root = makeTempRoot(t)
  const stale = path.join(root, 'sidekick-legacy-transaction-rollback-1')
  const fresh = path.join(root, 'sidekickai-asset-live')
  const foreign = path.join(root, 'dsh-workspace-changes-x')
  fs.mkdirSync(stale)
  fs.mkdirSync(fresh)
  fs.mkdirSync(foreign)
  fs.writeFileSync(path.join(stale, 'payload.bin'), 'x'.repeat(100))
  age(stale, 3)
  age(foreign, 3)

  const result = spawnSync(process.execPath, [script, `--max-age-hours=2`], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.ok(!fs.existsSync(stale), 'stale managed dir should be removed')
  assert.ok(fs.existsSync(fresh), 'recent managed dir should be kept')
  assert.ok(fs.existsSync(foreign), 'foreign dir must be kept')
})

test('CLI --dry-run reports without deleting', t => {
  const root = makeTempRoot(t)
  const stale = path.join(root, 'SidekickAI-Extract-dry')
  fs.mkdirSync(stale)
  age(stale, 3)
  const result = spawnSync(process.execPath, [script, '--dry-run', '--max-age-hours=2'], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.ok(fs.existsSync(stale))
  assert.match(result.stdout, /would remove SidekickAI-Extract-dry/)
})

test('CLI keeps SidekickAI-Uninstall until the worker grace period', t => {
  const root = makeTempRoot(t)
  const worker = path.join(root, 'SidekickAI-Uninstall')
  const oldWorker = path.join(root, 'SidekickAI-Uninstall-old')
  fs.mkdirSync(worker)
  fs.mkdirSync(oldWorker)
  age(worker, 3) // < 24h worker grace
  age(oldWorker, 48)

  const result = spawnSync(process.execPath, [script, '--max-age-hours=2'], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.ok(fs.existsSync(worker), 'live-ish worker root must stay')
  assert.ok(!fs.existsSync(oldWorker), 'stale worker root should go')
})
