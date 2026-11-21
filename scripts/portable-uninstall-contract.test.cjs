'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const contract = require('./portable-uninstall-contract.cjs')

const ROOT = path.resolve(__dirname, '..')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-portable-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('the portable uninstall contract matches the product identity and data directory', () => {
  const loaded = contract.loadContract(ROOT)
  const selection = JSON.parse(fs.readFileSync(path.join(ROOT, 'product-edition.json'), 'utf8'))
  const descriptor = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'contracts/distribution-product.json'), 'utf8'),
  )
  const product = require('../packages/product-contract/manifest.json')
  assert.equal(loaded.product.productId, descriptor.editions[selection.edition].packageName)
  assert.equal(loaded.product.productId, product.editions[selection.edition].packageName)
  assert.equal(loaded.rootOwned, true)
  assert.deepEqual(loaded.dataRoots, [
    { scope: 'install-root', path: product.portable.dataDirectory, recursive: true },
  ])
  assert.deepEqual(loaded.registrations, [])
})

test('the written package carries the fixed marker and the declared manifest', (t) => {
  const directory = fixture(t)
  const loaded = contract.loadContract(ROOT)
  const version = require('../package.json').version
  const manifest = contract.writePackageContract(directory, { contract: loaded, version })
  assert.equal(fs.readFileSync(path.join(directory, 'portable.txt'), 'utf8'), 'portable')
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    kind: 'portable-manifest',
    product: { productId: loaded.product.productId, version },
    rootOwned: true,
    dataRoots: [{ scope: 'install-root', path: 'data', recursive: true }],
    registrations: [],
  })
  const bytes = fs.readFileSync(path.join(directory, 'maintenance/portable.json'))
  assert.ok(bytes.equals(contract.manifestBytes(manifest)))
  assert.deepEqual(
    contract.verifyPackageContract(directory, { contract: loaded, version }),
    manifest,
  )
})

test('a package without both contract files is refused instead of guessed', (t) => {
  const directory = fixture(t)
  const loaded = contract.loadContract(ROOT)
  const version = require('../package.json').version
  contract.writePackageContract(directory, { contract: loaded, version })
  fs.unlinkSync(path.join(directory, 'maintenance/portable.json'))
  assert.throws(
    () => contract.verifyPackageContract(directory, { contract: loaded, version }),
    /manifest is missing/,
  )
  contract.writePackageContract(directory, { contract: loaded, version })
  fs.unlinkSync(path.join(directory, 'portable.txt'))
  assert.throws(
    () => contract.verifyPackageContract(directory, { contract: loaded, version }),
    /marker is missing/,
  )
})

test('an edited contract file is refused', (t) => {
  const directory = fixture(t)
  const loaded = contract.loadContract(ROOT)
  const version = require('../package.json').version
  contract.writePackageContract(directory, { contract: loaded, version })
  const target = path.join(directory, 'maintenance/portable.json')
  const edited = JSON.parse(fs.readFileSync(target, 'utf8'))
  edited.dataRoots[0].path = '../shared'
  fs.writeFileSync(target, JSON.stringify(edited, null, 2) + '\n')
  assert.throws(
    () => contract.verifyPackageContract(directory, { contract: loaded, version }),
    /differs from the project contract/,
  )
  fs.writeFileSync(path.join(directory, 'portable.txt'), 'portable\n')
  assert.throws(
    () => contract.verifyPackageContract(directory, { contract: loaded, version }),
    /differs from the project contract/,
  )
})

test('data root paths accept relative roots and reject escapes', () => {
  assert.equal(contract.validateDataRootPath('install-root', 'data'), 'data')
  assert.equal(contract.validateDataRootPath('install-root', 'data/cache'), 'data/cache')
  assert.equal(contract.validateDataRootPath('appdata', 'ExampleApp'), 'ExampleApp')
  for (const value of [
    '/data',
    'C:/data',
    'C:\\data',
    '..',
    '../data',
    'data/../..',
    './data',
    'data/',
    'data/.',
    'data ',
  ])
    assert.throws(
      () => contract.validateDataRootPath('install-root', value),
      /portable data root/i,
      value,
    )
  // 用户目录的数据根只能是相对该根的单段目录名
  for (const value of ['appdata/ExampleApp', 'nested/ExampleApp', '../ExampleApp'])
    assert.throws(
      () => contract.validateDataRootPath('appdata', value),
      /portable data root|one directory name/i,
      value,
    )
  assert.throws(() => contract.validateDataRootPath('programdata', 'ExampleApp'), /scope/)
})

test('manifest fields are closed to unknown additions', () => {
  const loaded = contract.loadContract(ROOT)
  const manifest = contract.buildManifest(loaded, require('../package.json').version)
  assert.throws(() => contract.validateManifest({ ...manifest, extra: true }), /manifest fields/)
  assert.throws(
    () => contract.validateManifest({ ...manifest, rootOwned: 'yes' }),
    /root ownership/,
  )
  assert.throws(
    () => contract.validateManifest({ ...manifest, product: { productId: 'x' } }),
    /product fields/,
  )
  assert.throws(
    () =>
      contract.validateManifest({
        ...manifest,
        dataRoots: [{ scope: 'install-root', path: 'data', recursive: false }],
      }),
    /recursively/,
  )
  assert.throws(
    () => contract.validateManifest({ ...manifest, kind: 'something-else' }),
    /manifest identity/,
  )
})

test('the contract refuses markers and manifests that do not match the project rules', () => {
  assert.throws(
    () =>
      contract.validateContract({
        schemaVersion: 1,
        kind: 'portable-uninstall-contract',
        marker: { path: 'portable.txt', content: 'Portable' },
        manifest: {
          path: 'maintenance/portable.json',
          schemaVersion: 1,
          kind: 'portable-manifest',
        },
        product: { productId: 'sidekickai-opensource' },
        rootOwned: true,
        dataRoots: [],
        registrations: [],
      }),
    /marker declaration/,
  )
  assert.throws(
    () =>
      contract.validateContract({
        schemaVersion: 1,
        kind: 'portable-uninstall-contract',
        marker: { path: 'portable.txt', content: 'portable' },
        manifest: {
          path: 'maintenance/portable.json',
          schemaVersion: 1,
          kind: 'portable-manifest',
        },
        product: { productId: 'sidekickai-opensource' },
        rootOwned: true,
        dataRoots: [{ scope: 'appdata', path: 'ExampleApp/nested', recursive: true }],
        registrations: [],
      }),
    /one directory name/,
  )
})
