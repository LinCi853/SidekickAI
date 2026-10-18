const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const esbuild = require('esbuild')

test('closed browser snapshots restore while the original application resumes editing', { timeout: 180000 }, async () => {
  const workspace = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-snapshot-runtime-'))
  const server = http.createServer((_request, response) => response.end('<!doctype html><title>Isolated backup snapshot</title>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const results = []
  try {
    for (const name of ['better-sqlite3', 'adm-zip']) {
      const moduleDirectory = path.join(directory, 'node_modules', name)
      fs.mkdirSync(moduleDirectory, { recursive: true })
      fs.writeFileSync(path.join(moduleDirectory, 'index.js'), `module.exports = require(${JSON.stringify(require.resolve(name))})`)
    }
    await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3', 'adm-zip'], logLevel: 'silent',
      stdin: { contents: `export * from './packages/backup-core/export'; export * from './packages/backup-core/files'; export * from './packages/backup-core/format'; export * from './packages/backup-core/file-crypto'; export * from './packages/backup-core/sessions'; export { verifyQuiescentSnapshot } from './electron/store/backup/verify';`, resolveDir: workspace },
      outfile: path.join(directory, 'core.cjs') })
    fs.copyFileSync(path.join(__dirname, 'fixtures/backup-snapshot-runtime.cjs'), path.join(directory, 'runtime.cjs'))
    const run = (mode, root, edition, encrypted, strict) => new Promise((resolve, reject) => {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [path.join(directory, 'runtime.cjs'), `--mode=${mode}`, `--root=${root}`, `--origin=${origin}`, `--edition=${edition}`, `--encrypted=${encrypted}`, `--strict=${strict}`, '--disable-gpu', '--disable-crashpad'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron ${mode} timed out: ${output}`)) }, 30000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(`Electron ${mode} failed (${code}): ${output}`)) })
    })
    for (const edition of ['community', 'concept']) for (const encrypted of [false, true]) for (const strict of [false, true]) {
      const root = path.join(directory, `${edition}-${encrypted ? 'encrypted' : 'plain'}-${strict ? 'maintenance' : 'snapshot'}`)
      fs.mkdirSync(root)
      for (const mode of ['seed', 'snapshot', 'restore', 'verify-source']) await run(mode, root, edition, encrypted, strict)
      const result = JSON.parse(fs.readFileSync(path.join(root, 'evidence.json'), 'utf8'))
      assert.equal(result.callbackCount, strict ? 0 : 1)
      assert.equal(result.encrypted, encrypted)
      assert.equal(result.restoredValue, 'snapshot value')
      assert.equal(result.sourceValue, strict ? 'snapshot value' : 'resumed value')
      assert.equal(result.cookieRestored, true)
      assert.equal(result.indexedDbRestored, true)
      results.push(result)
    }
    const evidenceDirectory = path.join(workspace, 'local/development/2026-10-07-unified-backup/runtime')
    if (fs.existsSync(evidenceDirectory)) fs.writeFileSync(path.join(evidenceDirectory, 'snapshot-roundtrip.json'), JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'Public backup core; isolated lifecycle adapter; product lifecycle adapter not covered.', results }, null, 2))
  } finally {
    server.close()
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.equal(path.basename(directory).startsWith('sidekick-snapshot-runtime-'), true)
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
