'use strict'

const fs = require('node:fs')
const path = require('node:path')
const u = require('./uninstaller-build-utils.cjs')

const ROOT = path.resolve(__dirname, '..')
const isProduction = file => !/(?:^|\/)(?:tests|__tests__)(?:\/|\.)|(?:[._-](?:test|tests|spec)\.(?:rs|tsx?|cjs|mjs))$|(?:^|\/)(?:tests|test-fixtures)\.rs$|\.md$/.test(file.replaceAll('\\', '/'))

function files(root, inputs) {
  return [...new Set(inputs.flatMap(relative => {
    const location = path.join(root, relative)
    if (!fs.existsSync(location)) throw new Error(`Maintenance build input is missing: ${relative}`)
    return fs.statSync(location).isDirectory() ? u.listFiles(location).filter(isProduction) : [location]
  }))].sort()
}

function frontendInputs(app, root = ROOT) {
  const name = path.basename(app)
  return files(root, [`${name}/src`, `${name}/index.html`, `${name}/package.json`, `${name}/tsconfig.json`, `${name}/vite.config.ts`,
    'installer-shared/uninstall', 'installer-shared/operation-details', 'installer-shared/presentation',
    'installer-tauri/package-lock.json', 'scripts/tauri-web-build.cjs',
    ...[`${name}/tsconfig.node.json`, ...(name === 'uninstaller-tauri' ? [`${name}/package-lock.json`] : [])].filter(file => fs.existsSync(path.join(root, file))),
    ...(name === 'installer-tauri' ? ['installer-shared/edition-policy.ts', 'packages/product-contract/identity.ts', 'packages/product-contract/manifest.json', 'product-edition.json'] : [])])
}

function sourceInputs(app, root = ROOT) {
  const name = path.basename(app)
  const optional = ['.cargo/config.toml', '.cargo/config', 'rust-toolchain.toml', 'rust-toolchain'].filter(file => fs.existsSync(path.join(root, file)))
  return [...new Set([...frontendInputs(app, root), ...files(root, [...optional, `${name}/src-tauri/src`, `${name}/src-tauri/Cargo.toml`,
    `${name}/src-tauri/Cargo.lock`, `${name}/src-tauri/build.rs`, `${name}/src-tauri/tauri.conf.json`,
    `${name}/src-tauri/icons`, `${name}/src-tauri/capabilities`, 'installer-shared/product.rs',
    'installer-shared/uninstall-core/src', 'installer-shared/uninstall-core/Cargo.toml', 'installer-shared/uninstall-core/build.rs',
    'installer-shared/uninstall-host/src', 'installer-shared/uninstall-host/Cargo.toml', 'installer-shared/uninstall-host/build.rs',
    'packages/product-contract/manifest.json', 'product-edition.json', 'maintenance/component-contract.json',
    ...(name === 'installer-tauri' ? ['installer-tauri/src-tauri/License.txt', 'installer-tauri/src-tauri/EULA.zh-CN.txt'] : [])])])].sort()
}

module.exports = { isProduction, files, frontendInputs, sourceInputs }
