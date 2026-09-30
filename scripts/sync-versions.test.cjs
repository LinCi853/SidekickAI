'use strict'

// The version sync tool must report drift without rewriting anything by default,
// rewrite every product copy on --apply (including package-lock and Cargo.lock
// entries), leave the independently versioned uninstall-core crate alone, and be
// idempotent so a second apply is a no-op.
//
// Every fixture is a mkdtemp tree: the real product files are never modified.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const sync = require('./sync-versions.cjs')

const SYNC = path.join(__dirname, 'sync-versions.cjs')
const PRODUCT_FILES = [
  'package-lock.json',
  'installer-tauri/package.json',
  'installer-tauri/package-lock.json',
  'installer-tauri/src-tauri/tauri.conf.json',
  'installer-tauri/src-tauri/Cargo.toml',
  'installer-tauri/src-tauri/Cargo.lock',
  'uninstaller-tauri/package.json',
  'uninstaller-tauri/src-tauri/tauri.conf.json',
  'uninstaller-tauri/src-tauri/Cargo.toml',
  'uninstaller-tauri/src-tauri/Cargo.lock',
  'installer-shared/uninstall-host/Cargo.toml',
  'installer-shared/uninstall-host/Cargo.lock',
]

function lockSource(entries) {
  return entries.map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`).join('\n')
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-sync-versions-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
  const write = (relative, contents) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  const json = value => JSON.stringify(value, null, 2) + '\n'
  write('maintenance/component-contract.json', json(require('../maintenance/component-contract.json')))
  write('package.json', json({ name: 'sidekickai', version: '1.2.3' }))
  write('package-lock.json', json({ name: 'sidekickai', version: '0.0.1', lockfileVersion: 3, requires: true, packages: { '': { name: 'sidekickai', version: '0.0.1' } } }))
  write('installer-tauri/package.json', json({ name: 'sidekickai-installer-tauri', version: '0.0.1' }))
  write('installer-tauri/package-lock.json', json({ name: 'sidekickai-installer-tauri', version: '0.0.1', lockfileVersion: 3, requires: true, packages: { '': { name: 'sidekickai-installer-tauri', version: '0.0.1' } } }))
  write('installer-tauri/src-tauri/tauri.conf.json', json({ productName: 'SidekickAI', version: '0.0.1' }))
  write('installer-tauri/src-tauri/Cargo.toml', '[workspace]\n\n[package]\nname = "sidekickai-installer"\nversion = "0.0.1"\nedition = "2021"\n')
  write('installer-tauri/src-tauri/Cargo.lock', lockSource([['sidekickai-installer', '0.0.1'], ['sidekickai-uninstall-core', '0.1.0'], ['sidekickai-uninstall-host', '0.0.1']]))
  write('uninstaller-tauri/package.json', json({ name: 'sidekickai-uninstaller-tauri', version: '0.0.1' }))
  write('uninstaller-tauri/src-tauri/tauri.conf.json', json({ productName: 'SidekickAI Uninstaller', version: '0.0.1' }))
  write('uninstaller-tauri/src-tauri/Cargo.toml', '[workspace]\n\n[package]\nname = "sidekickai-uninstaller"\nversion = "0.0.1"\nedition = "2021"\n')
  write('uninstaller-tauri/src-tauri/Cargo.lock', lockSource([['sidekickai-uninstall-core', '0.1.0'], ['sidekickai-uninstall-host', '0.0.1'], ['sidekickai-uninstaller', '0.0.1']]))
  write('installer-shared/uninstall-host/Cargo.toml', '[workspace]\n\n[package]\nname = "sidekickai-uninstall-host"\nversion = "0.0.1"\nedition = "2021"\n')
  write('installer-shared/uninstall-host/Cargo.lock', lockSource([['sidekickai-uninstall-core', '0.1.0'], ['sidekickai-uninstall-host', '0.0.1']]))
  write('installer-shared/uninstall-core/Cargo.toml', '[package]\nname = "sidekickai-uninstall-core"\nversion = "0.1.0"\nedition = "2021"\n')
  return { root, read, write }
}

function snapshotTree(root) {
  const snapshot = {}
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else snapshot[path.relative(root, file).replaceAll('\\', '/')] = fs.readFileSync(file, 'utf8')
    }
  }
  visit(root)
  return snapshot
}

test('check reports product drift without rewriting anything', t => {
  const { root, read } = fixture(t)
  const before = snapshotTree(root)
  const { findings, missing, requiredMissing } = sync.planVersions(root)
  assert.ok(findings.length > 0, 'drifted product files must be reported')
  assert.equal(findings.some(finding => finding.file === 'installer-shared/uninstall-core/Cargo.toml'), false, 'the independent core crate is never a target')
  assert.deepEqual(missing, ['uninstaller-tauri/package-lock.json'], 'a missing optional lock file is reported, not fatal')
  assert.deepEqual(requiredMissing, [], 'every mandatory target exists in this fixture')
  assert.deepEqual(snapshotTree(root), before, 'planning must not mutate any file')

  const result = spawnSync(process.execPath, [SYNC, '--check', '--root', root], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'check must fail while drift exists')
  assert.match(result.stderr, /version target\(s\) drifted from 1\.2\.3/)
  assert.deepEqual(snapshotTree(root), before, 'the CLI check must not mutate any file')
})

test('apply updates every product copy, preserves the independent core, and is idempotent', t => {
  const { root, read } = fixture(t)
  const result = sync.applyVersions(root)
  assert.deepEqual(result.changed.toSorted(), PRODUCT_FILES.filter(file => fs.existsSync(path.join(root, file))).toSorted())
  assert.deepEqual(result.remaining, [], 'no drift may remain after apply')

  assert.equal(JSON.parse(read('installer-tauri/package.json')).version, '1.0.0')
  assert.deepEqual(sync.jsonLockVersions(read('package-lock.json')), { version: '1.2.3', root: '1.2.3' })
  assert.deepEqual(sync.jsonLockVersions(read('installer-tauri/package-lock.json')), { version: '1.0.0', root: '1.0.0' })
  assert.equal(JSON.parse(read('installer-tauri/src-tauri/tauri.conf.json')).version, '1.0.0')
  assert.equal(sync.cargoPackageVersion(read('installer-tauri/src-tauri/Cargo.toml')).version, '1.0.0')
  assert.equal(sync.cargoPackageVersion(read('uninstaller-tauri/src-tauri/Cargo.toml')).version, '1.0.0')
  assert.equal(sync.cargoPackageVersion(read('installer-shared/uninstall-host/Cargo.toml')).version, '1.0.0')
  assert.equal(sync.cargoLockVersion(read('installer-tauri/src-tauri/Cargo.lock'), 'sidekickai-installer').version, '1.0.0')
  assert.equal(sync.cargoLockVersion(read('installer-tauri/src-tauri/Cargo.lock'), 'sidekickai-uninstall-host').version, '1.0.0')
  assert.equal(sync.cargoLockVersion(read('uninstaller-tauri/src-tauri/Cargo.lock'), 'sidekickai-uninstaller').version, '1.0.0')
  assert.equal(sync.cargoLockVersion(read('installer-shared/uninstall-host/Cargo.lock'), 'sidekickai-uninstall-host').version, '1.0.0')
  // The protocol core keeps its own version everywhere.
  assert.equal(sync.cargoPackageVersion(read('installer-shared/uninstall-core/Cargo.toml')).version, '0.1.0')
  assert.equal(sync.cargoLockVersion(read('installer-tauri/src-tauri/Cargo.lock'), 'sidekickai-uninstall-core').version, '0.1.0')
  assert.equal(sync.cargoLockVersion(read('uninstaller-tauri/src-tauri/Cargo.lock'), 'sidekickai-uninstall-core').version, '0.1.0')
  assert.equal(sync.cargoLockVersion(read('installer-shared/uninstall-host/Cargo.lock'), 'sidekickai-uninstall-core').version, '0.1.0')

  const applied = snapshotTree(root)
  const second = sync.applyVersions(root)
  assert.deepEqual(second.changed, [], 'a second apply is a no-op')
  assert.deepEqual(second.remaining, [])
  assert.deepEqual(snapshotTree(root), applied, 'a second apply must not rewrite a single byte')
  assert.deepEqual(sync.planVersions(root).findings, [])
})

test('a missing mandatory product file fails the check instead of reporting success', t => {
  const { root, write } = fixture(t)
  fs.rmSync(path.join(root, 'uninstaller-tauri', 'src-tauri', 'Cargo.toml'))
  const before = snapshotTree(root)
  const { findings, missing, requiredMissing } = sync.planVersions(root)
  assert.deepEqual(missing, ['uninstaller-tauri/package-lock.json'], 'only the uninstaller package-lock stays optional')
  assert.deepEqual(requiredMissing, ['uninstaller-tauri/src-tauri/Cargo.toml'])
  assert.ok(findings.length > 0)

  const checked = spawnSync(process.execPath, [SYNC, '--check', '--root', root], { encoding: 'utf8' })
  assert.notEqual(checked.status, 0)
  assert.match(checked.stderr, /Required version files are missing/)
  const applied = spawnSync(process.execPath, [SYNC, '--apply', '--root', root], { encoding: 'utf8' })
  assert.notEqual(applied.status, 0, 'apply must refuse a broken product config')
  assert.match(applied.stderr, /Required version files are missing/)
  assert.deepEqual(snapshotTree(root), before, 'a refused apply must not rewrite or create any file')
  write('uninstaller-tauri/src-tauri/Cargo.toml', '[package]\nname = "sidekickai-uninstaller"\nversion = "1.2.3"\n')
})

test('missing version fields fail checks and cannot cause a partial apply', t => {
  const { root, write } = fixture(t)
  write('uninstaller-tauri/src-tauri/Cargo.toml', '[package]\nname = "sidekickai-uninstaller"\n')
  const before = snapshotTree(root)
  const plan = sync.planVersions(root)
  assert.ok(plan.findings.some(finding => finding.current === null && finding.file.endsWith('Cargo.toml')))
  assert.throws(() => sync.applyVersions(root), /Required version fields are missing/)
  assert.deepEqual(snapshotTree(root), before)
  const checked = spawnSync(process.execPath, [SYNC, '--check', '--root', root], { encoding: 'utf8' })
  assert.notEqual(checked.status, 0)
})

test('the shared host Cargo.lock is included only when it exists', t => {
  const { root, write } = fixture(t)
  fs.rmSync(path.join(root, 'installer-shared', 'uninstall-host', 'Cargo.lock'))
  const plan = sync.planVersions(root)
  assert.equal(plan.requiredMissing.includes('installer-shared/uninstall-host/Cargo.lock'), false, 'an absent host lock is not a required target')
  assert.equal(plan.missing.includes('installer-shared/uninstall-host/Cargo.lock'), false, 'an absent host lock is not reported as an optional skip either')
  assert.equal(plan.findings.some(finding => finding.file === 'installer-shared/uninstall-host/Cargo.lock'), false)
  const result = sync.applyVersions(root)
  assert.equal(result.changed.includes('installer-shared/uninstall-host/Cargo.lock'), false)
  // When the file appears it becomes mandatory again.
  write('installer-shared/uninstall-host/Cargo.lock', lockSource([['sidekickai-uninstall-host', '0.0.1']]))
  assert.ok(sync.planVersions(root).findings.some(finding => finding.file === 'installer-shared/uninstall-host/Cargo.lock'))
})

test('the root version must be a valid semver and cannot be overridden on the command line', t => {
  const { root, read, write } = fixture(t)
  write('package.json', JSON.stringify({ name: 'sidekickai', version: 'not-semver' }, null, 2) + '\n')
  assert.throws(() => sync.rootPackageVersion(root), /valid semver/)
  const checked = spawnSync(process.execPath, [SYNC, '--check', '--root', root], { encoding: 'utf8' })
  assert.notEqual(checked.status, 0)
  assert.match(checked.stderr, /valid semver/)

  write('package.json', JSON.stringify({ name: 'sidekickai', version: '1.2.3' }, null, 2) + '\n')
  const before = read('package.json')
  const overridden = spawnSync(process.execPath, [SYNC, '--apply', '--root', root, '--version', '9.9.9'], { encoding: 'utf8' })
  assert.notEqual(overridden.status, 0, 'a second version source must be rejected')
  assert.match(overridden.stderr, /Usage: sync-versions\.cjs/)
  assert.equal(read('package.json'), before, 'no version override may rewrite the root manifest')
})

test('the CLI apply/check round-trip is idempotent through the real command line', t => {
  const { root } = fixture(t)
  const applied = spawnSync(process.execPath, [SYNC, '--apply', '--root', root], { encoding: 'utf8' })
  assert.equal(applied.status, 0, applied.stderr)
  assert.match(applied.stdout, /Applied 1\.2\.3/)
  const again = spawnSync(process.execPath, [SYNC, '--apply', '--root', root], { encoding: 'utf8' })
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /Applied 1\.2\.3: 0 file\(s\) updated/)
  const checked = spawnSync(process.execPath, [SYNC, '--check', '--root', root], { encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(checked.stdout, /Product 1\.2\.3; maintenance 1\.0\.0/)
})

test('rewrites preserve indentation, trailing newlines and CRLF line endings', () => {
  const crlf = '[package]\r\nname = "x"\r\nversion = "0.0.1"\r\n'
  assert.equal(sync.rewriteCargoPackageVersion(crlf, '2.0.0'), '[package]\r\nname = "x"\r\nversion = "2.0.0"\r\n')
  assert.equal(sync.rewriteCargoPackageVersion(crlf, '0.0.1'), crlf, 'an unchanged version is a byte-identical no-op')
  const json = '{\n  "name": "x",\n  "version": "0.0.1"\n}\n'
  assert.equal(sync.rewriteJsonVersion(json, '2.0.0'), '{\n  "name": "x",\n  "version": "2.0.0"\n}\n')
  const lock = '[[package]]\nname = "sidekickai-installer"\nversion = "0.0.1"\n'
  assert.equal(sync.rewriteCargoLockVersions(lock, '2.0.0', ['sidekickai-installer']), '[[package]]\nname = "sidekickai-installer"\nversion = "2.0.0"\n')
  // A version line that is not inside [package] is never touched.
  const dependency = '[dependencies]\nsidekickai = { version = "0.0.1" }\n\n[package]\nname = "x"\nversion = "0.0.1"\n'
  assert.equal(sync.cargoPackageVersion(dependency).version, '0.0.1')
})
