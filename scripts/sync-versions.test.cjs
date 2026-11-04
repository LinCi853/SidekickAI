'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const sync = require('./sync-versions.cjs')

function fixture(t) {
  const parent = path.resolve(__dirname, '../build/version-tests')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'software-'))
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true }) })
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n')
  write('package.json', { name: 'software', version: '1.2.3' })
  write('package-lock.json', { name: 'software', version: '0.0.1', packages: { '': { name: 'software', version: '0.0.1' } } })
  return { root, write, read: file => fs.readFileSync(path.join(root, file), 'utf8') }
}

test('checking a software-only workspace reports drift without changing bytes', t => {
  const { root, read } = fixture(t)
  const before = read('package-lock.json')
  assert.equal(sync.planVersions(root).findings.length, 2)
  assert.deepEqual(sync.planVersions(root).requiredMissing, [])
  assert.equal(read('package-lock.json'), before)
  assert.throws(() => sync.main(['--root', root, '--check']), /drift/)
  assert.equal(read('package-lock.json'), before)
})

test('apply updates only the root lock and is idempotent', t => {
  const { root, read, write } = fixture(t)
  write('independent.json', { version: '8.8.8' })
  const application = read('package.json')
  assert.deepEqual(sync.applyVersions(root).changed, ['package-lock.json'])
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(lock.version, '1.2.3')
  assert.equal(lock.packages[''].version, '1.2.3')
  assert.equal(read('package.json'), application)
  assert.equal(JSON.parse(read('independent.json')).version, '8.8.8')
  assert.deepEqual(sync.applyVersions(root).changed, [])
  assert.deepEqual(sync.planVersions(root).findings, [])
})

test('missing lock or required fields fails without partial writes', t => {
  const { root, write, read } = fixture(t)
  write('package-lock.json', { version: '0.0.1', packages: {} })
  const before = read('package-lock.json')
  assert.throws(() => sync.applyVersions(root), /fields are missing/)
  assert.equal(read('package-lock.json'), before)
  fs.unlinkSync(path.join(root, 'package-lock.json'))
  assert.throws(() => sync.applyVersions(root), /files are missing/)
  assert.equal(fs.existsSync(path.join(root, 'package-lock.json')), false)
})

test('the CLI uses the package version and rejects another version source', t => {
  const { root, write, read } = fixture(t)
  const script = path.join(__dirname, 'sync-versions.cjs')
  const invoke = args => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(invoke(['--apply']).status, 0)
  assert.equal(invoke(['--check']).status, 0)
  const before = read('package-lock.json')
  assert.notEqual(invoke(['--apply', '--version', '9.9.9']).status, 0)
  assert.equal(read('package-lock.json'), before)
  write('package.json', { version: 'invalid' })
  assert.throws(() => sync.rootPackageVersion(root), /valid semver/)
  assert.notEqual(invoke(['--apply']).status, 0)
  assert.equal(read('package-lock.json'), before)
})
