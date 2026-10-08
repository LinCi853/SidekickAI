const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

test('sensitive draft metadata rejects ambiguous, oversized and invalid entries', () => {
  const source = fs.readFileSync(path.join(__dirname, '../packages/backup-core/sensitive-drafts-format.ts'), 'utf8')
  const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code
  const output = { exports: {} }
  new Function('module', 'exports', 'Buffer', code)(output, output.exports, Buffer)
  const { validateSensitiveDrafts, MAX_DRAFT_BYTES, MAX_DRAFT_ENTRIES } = output.exports
  const valid = { version: 1, entries: [{ key: 'windowDraft:settings:network', sourceSha256: 'a'.repeat(64), state: 'portable', value: { enabled: true } }] }
  assert.doesNotThrow(() => validateSensitiveDrafts(valid))
  for (const entry of [
    { ...valid.entries[0], key: '../settings' },
    { ...valid.entries[0], sourceSha256: 'invalid' },
    { ...valid.entries[0], value: undefined },
    { ...valid.entries[0], value: 'x'.repeat(MAX_DRAFT_BYTES + 1) },
    { ...valid.entries[0], state: 'unavailable', reason: 'source-key-unavailable' },
    null,
  ]) assert.throws(() => validateSensitiveDrafts({ version: 1, entries: [entry] }))
  assert.throws(() => validateSensitiveDrafts({ version: 1, entries: [valid.entries[0], valid.entries[0]] }))
  assert.throws(() => validateSensitiveDrafts({ version: 2, entries: [] }))
  assert.throws(() => validateSensitiveDrafts({ version: 1, entries: Array(MAX_DRAFT_ENTRIES + 1).fill(valid.entries[0]) }))
  assert.doesNotThrow(() => validateSensitiveDrafts({ version: 1, entries: [{ key: valid.entries[0].key, sourceSha256: 'b'.repeat(64), state: 'unavailable', reason: 'source-key-unavailable' }] }))
})

test('sensitive drafts cross encryption contexts through live and offline backup exports', { timeout: 240000 }, async () => {
  const workspace = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(workspace, 'build/verification/backup-drafts-'))
  const edition = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')).name === 'sidekickai-opensource' ? 'concept' : 'community'
  const results = []
  for (const name of ['better-sqlite3', 'adm-zip']) {
    const target = path.join(directory, 'node_modules', name)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'index.js'), `module.exports = require(${JSON.stringify(require.resolve(name))})`)
  }
  await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'adm-zip'], logLevel: 'silent',
    stdin: { contents: ['export', 'files', 'format', 'file-crypto', 'sessions', 'sensitive-drafts', 'sensitive-drafts-format'].map(name => `export * from './packages/backup-core/${name}';`).join('\n'), resolveDir: workspace },
    outfile: path.join(directory, 'core.cjs') })
  fs.copyFileSync(path.join(__dirname, 'fixtures/backup-drafts-runtime.cjs'), path.join(directory, 'runtime.cjs'))
  const run = (mode, root, encrypted, cookies, offline) => new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.SIDEKICK_DATA_DIR
    const child = spawn(require('electron'), [path.join(directory, 'runtime.cjs'), `--root=${root}`, `--mode=${mode}`, `--edition=${edition}`, `--encrypted=${encrypted}`, `--cookies=${cookies}`, `--offline=${offline}`, '--disable-gpu', '--disable-crashpad'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timeout = setTimeout(() => child.kill(), 40000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${mode} failed (${code}): ${output}`)) })
  })
  for (const encrypted of [false, true]) for (const cookies of [false, true]) for (const offline of [false, true]) {
    const root = path.join(directory, `${encrypted}-${cookies}-${offline}`)
    fs.mkdirSync(root)
    for (const mode of offline ? ['seed', 'offline', 'restore', 'cold'] : ['live', 'restore', 'cold']) await run(mode, root, encrypted, cookies, offline)
    const result = JSON.parse(fs.readFileSync(path.join(root, 'evidence.json'), 'utf8'))
    assert(result.sourcePreserved && result.targetReencrypted && result.coldReopenPassed && result.tamperRejected && result.legacyUnavailableDiscarded && result.transientEncryptionPreserved && result.obsoleteRecoveryRemoved)
    results.push(result)
  }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ passed: true, scope: 'Isolated backup-core adapter with actual Electron safeStorage and SQLite; complete application startup is validated separately.', results }, null, 2))
  console.log(`Sensitive draft evidence: ${directory}`)
})
