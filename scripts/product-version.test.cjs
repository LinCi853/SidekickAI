const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const test = require('node:test')
const { synchronize } = require('../packages/product-contract/sync.cjs')
const { productIdentity } = require('./build-distribution.cjs')
const { readContext } = require('./workspace-menu.cjs')

function fixture(t, edition, version) {
  const build = path.resolve(__dirname, '../build')
  fs.mkdirSync(build, { recursive: true })
  const root = fs.mkdtempSync(path.join(build, 'product-version-test-'))
  t.after(() => {
    assert(root.startsWith(build + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const product = require('../packages/product-contract/manifest.json')
  const common = { ...product }
  delete common.version
  const json = (file, value) => {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n')
  }
  json('packages/product-contract/manifest.json', common)
  json('maintenance/component-contract.json', require('../maintenance/component-contract.json'))
  json('product-edition.json', { edition })
  json('package.json', { name: product.editions[edition].packageName, version })
  json('package-lock.json', { version: '9.9.9', packages: { '': { version: '9.9.9' } } })
  json('installer-tauri/package.json', { name: 'installer', version: '9.9.9' })
  json('uninstaller-tauri/package.json', { name: 'uninstaller', version: '9.9.9' })
  return root
}

test('each edition projects its own release version from package metadata', t => {
  const concept = fixture(t, 'concept', '0.1.5')
  const community = fixture(t, 'community', '0.1.0-beta.5')
  for (const [root, version] of [[concept, '0.1.5'], [community, '0.1.0-beta.5']]) {
    assert.equal(synchronize(root, true).version, version)
    assert.deepEqual(synchronize(root).changed, [])
    assert.equal(productIdentity(root).version, version)
    assert.equal(readContext(root).product.version, version)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'installer-tauri/package.json'))).version, require('../maintenance/component-contract.json').componentVersion)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages[''].version, version)
  }
  assert.deepEqual(fs.readFileSync(path.join(concept, 'packages/product-contract/manifest.json')), fs.readFileSync(path.join(community, 'packages/product-contract/manifest.json')))
})

test('concept accepts numbered releases and rejects prerelease labels before writing', t => {
  const root = fixture(t, 'concept', '0.1.5-beta.1')
  const file = path.join(root, 'installer-tauri/package.json')
  const before = fs.readFileSync(file)
  assert.throws(() => synchronize(root, true), /正式版本|stable release/i)
  assert.deepEqual(fs.readFileSync(file), before)
})

test('shared source never pins edition-specific product version files', () => {
  const shared = require('../maintenance/shared-source.json')
  const pinned = new Set(Object.keys(shared.files))
  assert(!pinned.has('package.json'))
  assert(!pinned.has('package-lock.json'))
  assert.equal(Object.hasOwn(require('../packages/product-contract/manifest.json'), 'version'), false)
})
