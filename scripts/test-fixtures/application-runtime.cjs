'use strict'

const fs = require('node:fs')
const path = require('node:path')
const application = require('../application-packaging.cjs')
const runtime = require('../application-runtime.cjs')

function pe(arch) {
  const bytes = Buffer.alloc(1024)
  bytes.write('MZ')
  bytes.writeUInt32LE(128, 0x3c)
  bytes.write('PE\0\0', 128)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132)
  bytes.writeUInt16LE(1, 134)
  bytes.writeUInt16LE(240, 148)
  bytes.writeUInt16LE(0x20b, 152)
  bytes.writeUInt32LE(512, 212)
  bytes.writeUInt32LE(512, 408)
  bytes.writeUInt32LE(512, 412)
  return bytes
}

async function createRuntime(root, arch, { edition = application.EDITION, productVersion = application.VERSION } = {}) {
  const directory = path.join(root, application.TARGETS[arch].directory)
  for (const name of application.REQUIRED_RUNTIME_FILES) {
    if (name === 'resources/app.asar') continue
    const file = path.join(directory, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, /\.(?:exe|dll)$/i.test(name) ? pe(arch) : Buffer.from('fixture ' + name))
  }
  const packageRoot = path.join(root, 'asar-' + arch)
  const loader = 'node_modules/node-gyp-build/node-gyp-build.js'
  fs.mkdirSync(path.dirname(path.join(packageRoot, loader)), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: require('../../packages/product-contract/manifest.json').editions[edition].packageName, version: productVersion }))
  fs.copyFileSync(require.resolve('node-gyp-build/node-gyp-build.js'), path.join(packageRoot, loader))
  await require('node:stream/promises').finished(await require('@electron/asar').createPackage(packageRoot, path.join(directory, 'resources/app.asar')))
  const native = path.join(directory, 'resources/app.asar.unpacked/node_modules')
  for (const name of ['better-sqlite3/prebuilds/win32-' + arch + '.node', 'uiohook-napi/prebuilds/win32-' + arch + '/uiohook-napi.node']) {
    fs.mkdirSync(path.dirname(path.join(native, name)), { recursive: true })
    fs.writeFileSync(path.join(native, name), pe(arch))
  }
  runtime.writeApplicationConfiguration(directory, { origin: '', keys: [], resourceKeys: [] })
  return directory
}

module.exports = { pe, createRuntime }
