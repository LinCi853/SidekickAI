'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { rootPackageVersion } = require('../../scripts/sync-versions.cjs')

function synchronize(root, apply = false) {
  const product = { ...JSON.parse(fs.readFileSync(path.join(root, 'packages/product-contract/manifest.json'), 'utf8')), version: rootPackageVersion(root) }
  const { edition: id } = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8'))
  const edition = product.editions[id]
  if (!edition) throw new Error('Invalid product configuration')
  if (id === 'concept' && !/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error('概念版只使用三段数字的正式版本号。')
  const changed = []
  function update(relative, transform) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) return
    const source = fs.readFileSync(file, 'utf8')
    const result = transform(source)
    if (source === result) return
    changed.push(relative)
    if (apply) fs.writeFileSync(file, result)
  }
  function json(relative, transform) {
    update(relative, source => {
      const value = JSON.parse(source)
      const before = JSON.stringify(value)
      transform(value)
      return before === JSON.stringify(value) ? source : JSON.stringify(value, null, 2) + '\n'
    })
  }
  for (const directory of ['', 'installer-tauri/', 'uninstaller-tauri/']) {
    json(directory + 'package.json', value => {
      value.version = product.version
      if (!directory) { value.name = edition.packageName; delete value.productName }
    })
    json(directory + 'package-lock.json', value => {
      value.version = product.version
      if (value.packages?.['']) value.packages[''].version = product.version
    })
  }
  for (const [directory, role] of [['installer-tauri', 'installer'], ['uninstaller-tauri', 'uninstaller']]) {
    json(directory + '/src-tauri/tauri.conf.json', value => {
      value.version = product.version
      value.productName = product.name
      value.identifier = edition.appId + '.' + role
      value.app.windows[0].title = product.displayName + (role === 'installer' ? '安装向导' : '卸载向导')
    })
  }
  for (const directory of ['installer-tauri/src-tauri', 'uninstaller-tauri/src-tauri', 'installer-shared/uninstall-host']) {
    update(directory + '/Cargo.toml', source => source.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+"/, '$1' + product.version + '"'))
    update(directory + '/Cargo.lock', source => source.replace(/(\[\[package\]\]\r?\nname = "sidekickai-(?:installer|uninstaller|uninstall-host)"\r?\nversion = ")[^"]+"/g, '$1' + product.version + '"'))
  }
  for (const file of ['electron-builder.yml', 'electron-builder.portable.yml']) {
    update(file, source => source.replace(/^appId: .+$/m, 'appId: ' + edition.appId).replace(/^productName: .+$/m, 'productName: ' + product.name))
  }
  if (changed.length && !apply) throw new Error('Product configuration drift: ' + changed.join(', '))
  return { edition: id, version: product.version, changed, applied: apply }
}

module.exports = { synchronize }
if (require.main === module) {
  try { console.log(JSON.stringify(synchronize(path.resolve(__dirname, '../..'), process.argv.includes('--apply')), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
