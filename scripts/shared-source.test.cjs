const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const shared = require('./shared-source.cjs')

function fixture(t) {
  const build = path.resolve(__dirname, '../build')
  fs.mkdirSync(build, { recursive: true })
  const root = fs.mkdtempSync(path.join(build, 'shared-source-test-'))
  t.after(() => {
    assert(root.startsWith(build + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'concept')
  const consumer = path.join(root, 'community')
  for (const [directory, edition] of [[source, 'concept'], [consumer, 'community']]) {
    fs.mkdirSync(path.join(directory, 'maintenance'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'product-edition.json'), JSON.stringify({ edition }))
    fs.writeFileSync(path.join(directory, 'shared.txt'), 'original')
    fs.writeFileSync(path.join(directory, 'maintenance/shared-source.json'), JSON.stringify({ schemaVersion: 1, owner: 'concept', files: { 'shared.txt': crypto.createHash('sha256').update('original').digest('hex') } }))
  }
  shared.refresh(source)
  fs.copyFileSync(path.join(source, 'maintenance/shared-source.json'), path.join(consumer, 'maintenance/shared-source.json'))
  return { source, consumer }
}

test('a pinned consumer builds independently and accepts an explicit shared update', t => {
  const { source, consumer } = fixture(t)
  assert.equal(shared.check(consumer).files, 1)
  fs.writeFileSync(path.join(source, 'shared.txt'), 'updated')
  assert.throws(() => shared.check(source), /differs/)
  shared.refresh(source)
  shared.synchronize(source, consumer)
  assert.equal(fs.readFileSync(path.join(consumer, 'shared.txt'), 'utf8'), 'updated')
  assert.equal(shared.check(consumer).revision, shared.check(source).revision)
})

test('a local consumer edit is never overwritten by synchronization', t => {
  const { source, consumer } = fixture(t)
  fs.writeFileSync(path.join(source, 'shared.txt'), 'updated')
  shared.refresh(source)
  fs.writeFileSync(path.join(consumer, 'shared.txt'), 'local work')
  assert.throws(() => shared.synchronize(source, consumer), /local changes/)
  assert.equal(fs.readFileSync(path.join(consumer, 'shared.txt'), 'utf8'), 'local work')
  assert.throws(() => shared.refresh(consumer), /Only the concept/)
})

test('the shared manifest cannot select a file outside the workspace', t => {
  const { source } = fixture(t)
  for (const relative of ['../private.json', '/private.json', 'nested/../../private.json', 'nested\\private.json', 'file:stream', 'nested./file', 'nested /file']) {
    assert.throws(() => shared.resolveFile(source, relative), /shared path|Shared path/i)
  }
})

test('synchronization preserves a locally deleted shared file', t => {
  const { source, consumer } = fixture(t)
  fs.unlinkSync(path.join(consumer, 'shared.txt'))
  assert.throws(() => shared.synchronize(source, consumer), /local changes/)
  assert.equal(fs.existsSync(path.join(consumer, 'shared.txt')), false)
})

test('an interrupted write restores earlier files and retains recovery evidence', t => {
  const { source, consumer } = fixture(t)
  fs.writeFileSync(path.join(source, 'shared.txt'), 'updated')
  shared.refresh(source)
  const before = fs.readFileSync(path.join(consumer, 'maintenance/shared-source.json'))
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(consumer, 'maintenance/shared-source.json')) throw new Error('fixture write failure')
    fs.renameSync(from, to)
  } }
  assert.throws(() => shared.synchronize(source, consumer, io), /fixture write failure/)
  assert.equal(fs.readFileSync(path.join(consumer, 'shared.txt'), 'utf8'), 'original')
  assert.deepEqual(fs.readFileSync(path.join(consumer, 'maintenance/shared-source.json')), before)
  assert.equal(shared.check(consumer).files, 1)
  const evidence = fs.readdirSync(path.join(consumer, 'build')).find(name => name.startsWith('shared-sync-'))
  const report = JSON.parse(fs.readFileSync(path.join(consumer, 'build', evidence, 'report.json')))
  assert.equal(report.status, 'rolled-back')
  assert.equal(shared.synchronize(source, consumer).revision, shared.check(source).revision)
})

test('new user edits during a failed synchronization survive rollback', t => {
  const { source, consumer } = fixture(t)
  fs.writeFileSync(path.join(source, 'shared.txt'), 'updated')
  shared.refresh(source)
  const io = { ...fs, renameSync(from, to) {
    if (to === path.join(consumer, 'maintenance/shared-source.json')) {
      fs.writeFileSync(path.join(consumer, 'shared.txt'), 'new user work')
      throw new Error('fixture write failure')
    }
    fs.renameSync(from, to)
  } }
  assert.throws(() => shared.synchronize(source, consumer, io), /fixture write failure/)
  assert.equal(fs.readFileSync(path.join(consumer, 'shared.txt'), 'utf8'), 'new user work')
  assert.throws(() => shared.check(consumer), /differs/)
})
