const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const asar = require('@electron/asar')

const machines = { x64: 0x8664, arm64: 0xaa64 }

function assertMachine(file, arch) {
  const bytes = fs.readFileSync(file)
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Invalid Windows binary: ${file}`)
  const offset = bytes.readUInt32LE(60)
  if (offset > bytes.length - 6 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error(`Invalid PE header: ${file}`)
  if (bytes.readUInt16LE(offset + 4) !== machines[arch]) throw new Error(`Native architecture mismatch: expected ${arch}: ${file}`)
}

function resolveHookBinding(loader, directory, arch) {
  const module = { exports: {} }
  vm.runInNewContext(loader, {
    module,
    exports: module.exports,
    Buffer,
    process: { env: {}, versions: { electron: '43.6.0', modules: '148', node: '24.0.0', uv: '1.0' }, config: { variables: {} }, execPath: path.join(directory, 'SidekickAI.exe') },
    require: (name) => name === 'os' ? { arch: () => arch, platform: () => 'win32' } : require(name),
  }, { filename: 'packaged-node-gyp-build.js', timeout: 1000 })
  const selected = module.exports.resolve(directory)
  assertMachine(selected, arch)
  return selected
}

function verifyPackagedNative(appDirectory, arch) {
  if (!Object.hasOwn(machines, arch)) throw new Error(`Unsupported Windows architecture: ${arch}`)
  const archive = path.join(appDirectory, 'resources', 'app.asar')
  const unpacked = path.join(appDirectory, 'resources', 'app.asar.unpacked', 'node_modules')
  assertMachine(path.join(appDirectory, 'SidekickAI.exe'), arch)
  const sqlite = path.join(unpacked, 'better-sqlite3', 'prebuilds', `win32-${arch}.node`)
  assertMachine(sqlite, arch)
  const loader = asar.extractFile(archive, path.join('node_modules', 'node-gyp-build', 'node-gyp-build.js')).toString()
  const hook = resolveHookBinding(loader, path.join(unpacked, 'uiohook-napi'), arch)
  if (path.resolve(hook) !== path.resolve(unpacked, 'uiohook-napi', 'prebuilds', `win32-${arch}`, 'uiohook-napi.node')) {
    throw new Error(`Packaged keyboard hook selected a development build: ${hook}`)
  }
  const result = { arch, sqlite: path.relative(appDirectory, sqlite), hook: path.relative(appDirectory, hook) }
  console.log(`[native-package] Verified ${arch} application, SQLite and keyboard hook`)
  return result
}

if (require.main === module) {
  const [directory, arch] = process.argv.slice(2)
  if (!directory || !arch) throw new Error('Usage: verify-packaged-native.cjs <application-directory> <x64|arm64>')
  console.log(JSON.stringify(verifyPackagedNative(path.resolve(directory), arch), null, 2))
}

module.exports = { assertMachine, resolveHookBinding, verifyPackagedNative }
