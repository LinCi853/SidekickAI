'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { generateManifest } = require('./gen-install-manifest.cjs')
const edition = require('../product-edition.json').edition
const path = require('node:path')
const root = path.resolve(__dirname, '..')

test('installation metadata exposes only the edition-owned optional components', () => {
  const manifest = generateManifest()
  assert.equal(manifest.edition, edition)
  assert.deepEqual(manifest.features, [])
  assert.deepEqual(manifest.options.map(option => option.id), edition === 'concept'
    ? ['autoLaunch', 'logLevel', 'usageTracking']
    : ['autoUpdate', 'autoLaunch', 'logLevel'])
})

test('the installer cache tracks edition policy and both hosts track version presentation', () => {
  const { frontendInputs } = require('./maintenance-inputs.cjs')
  for (const name of ['installer-tauri', 'uninstaller-tauri']) {
    const inputs = frontendInputs(path.join(root, name)).map(file => path.relative(root, file).replaceAll('\\', '/'))
    assert.equal(inputs.includes('installer-shared/edition-policy.ts'), name === 'installer-tauri')
    assert.equal(inputs.includes('installer-shared/presentation/version.ts'), true)
    assert.equal(inputs.includes('packages/plugin-sdk/semver.mjs'), false)
  }
})
