const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const esbuild = require('esbuild')

const workspace = path.resolve(__dirname, '..')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-json-sharing-'))
const evidence = []
let core
before(async () => {
  await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    stdin: { resolveDir: workspace, contents: `export * from './packages/backup-core/io';` }, outfile: path.join(base, 'core.cjs') })
  core = require(path.join(base, 'core.cjs'))
})
after(() => {
  if (process.env.BACKUP_SHARING_EVIDENCE) fs.writeFileSync(path.resolve(process.env.BACKUP_SHARING_EVIDENCE), JSON.stringify({ workspace, checkedAt: new Date().toISOString(), evidence }, null, 2))
  assert.equal(path.dirname(base), os.tmpdir())
  assert.ok(path.basename(base).startsWith('sidekick-json-sharing-'))
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function lockFile(file, milliseconds) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures/backup-json-lock.ps1'), '-Target', file, '-HoldMilliseconds', String(milliseconds)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let output = '', errors = ''
  child.stderr.on('data', bytes => { errors += bytes })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Lock helper did not become ready')) }, 10000)
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('locked')) { clearTimeout(timer); resolve() } })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('locked')) reject(new Error(`Lock helper exited ${code}: ${errors}`)) })
  })
  return { release: () => child.stdin.end('release\n'), wait: async () => { const [code] = await exited; assert.equal(code, 0, errors) } }
}

test('an ordinary async reader reproduces Windows replacement sharing failure until its handle closes', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(base, 'reader.json'), scratch = `${file}.tmp`
  fs.writeFileSync(file, 'original'); fs.writeFileSync(scratch, 'replacement')
  const reader = await fs.promises.open(file, 'r')
  let observed
  try { assert.throws(() => fs.renameSync(scratch, file), error => { observed = error.code; return ['EPERM', 'EACCES', 'EBUSY'].includes(error.code) }) }
  finally { await reader.close() }
  assert.equal(fs.readFileSync(file, 'utf8'), 'original')
  fs.renameSync(scratch, file)
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement')
  evidence.push({ test: 'ordinary async read handle', observed, successAfterClose: true })
})

test('atomic JSON survives a brief real deny-delete handle without replacing the temporary file', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const file = path.join(base, 'brief.json')
  fs.writeFileSync(file, '{"value":"original"}')
  const lock = await lockFile(file, 100)
  lock.release()
  const started = performance.now()
  let failure
  try { core.atomicJson(file, { value: 'replacement' }) } catch (error) { failure = error }
  const elapsed = performance.now() - started
  await lock.wait()
  evidence.push({ test: 'brief deny-delete handle', elapsed, error: failure?.code })
  assert.equal(failure, undefined)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 'replacement' })
  assert.equal(fs.readdirSync(base).filter(name => name.startsWith('brief.json.')).length, 0)
})

test('persistent sharing failure stays bounded and preserves the complete original record', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const file = path.join(base, 'persistent.json'), original = '{"value":"original"}'
  fs.writeFileSync(file, original)
  const lock = await lockFile(file, 1200)
  lock.release()
  const started = performance.now()
  let failure
  try { core.atomicJson(file, { value: 'replacement' }) } catch (error) { failure = error }
  const elapsed = performance.now() - started
  try {
    assert.ok(failure && ['EPERM', 'EACCES', 'EBUSY'].includes(failure.code))
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.ok(elapsed < 900, `Replacement exceeded the bounded retry budget: ${elapsed}`)
  } finally { await lock.wait() }
  assert.equal(fs.readdirSync(base).filter(name => name.startsWith('persistent.json.')).length, 0)
  evidence.push({ test: 'persistent deny-delete handle', elapsed, error: failure.code, originalPreserved: true })
})

test('replacement retries only sharing errors and keeps the same flushed temporary path', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(base, 'codes.json')
  const rename = fs.renameSync
  try {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EINVAL']) {
      fs.writeFileSync(file, '{"value":"original"}')
      const attempts = []
      fs.renameSync = (source, target) => {
        attempts.push([source, target])
        if (attempts.length === 1) throw Object.assign(new Error(code), { code })
        return rename(source, target)
      }
      if (['EPERM', 'EACCES', 'EBUSY'].includes(code)) {
        core.atomicJson(file, { value: code })
        assert.equal(attempts.length, 2)
        assert.deepEqual(attempts[0], attempts[1])
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: code })
      } else {
        assert.throws(() => core.atomicJson(file, { value: code }), { code })
        assert.equal(attempts.length, 1)
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 'original' })
      }
    }
  } finally { fs.renameSync = rename }
})
