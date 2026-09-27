'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const u = require('./uninstaller-build-utils.cjs')
const { verifyPackagedNative } = require('./verify-packaged-native.cjs')
const { ROOT, VERSION, validateArchitectures, applicationFingerprint } = require('./build-tauri-installer.cjs')
const product = require('../packages/product-contract/manifest.json')
const selection = require('../product-edition.json')

const SEVENZ = process.env.SIDEKICK_7Z || 'C:\\Program Files\\7-Zip\\7z.exe'
const DIRECTORY_NAME = product.name
const LAYOUT = product.portable
const MARKER = 'SidekickAI Dual Architecture Portable Marker\n'
const MIN_ZIP_BYTES = 120 * 1024 * 1024
const REQUIRED_RUNTIME_FILES = [
  product.executable, 'resources/app.asar', 'resources/LICENSE.application.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak', 'icudtl.dat',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll',
  'd3dcompiler_47.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
  'locales/en-US.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak',
]
const REQUIRED_ENTRIES = [
  `${DIRECTORY_NAME}/${LAYOUT.launcher}`,
  `${DIRECTORY_NAME}/portable-layout.json`,
  `${DIRECTORY_NAME}/portable-manifest.json`,
  ...Object.values(LAYOUT.runtimes).flatMap(directory => [
    `${DIRECTORY_NAME}/${directory}/${product.executable}`,
    `${DIRECTORY_NAME}/${directory}/resources/app.asar`,
    `${DIRECTORY_NAME}/${directory}/portable.txt`,
  ]),
]
const FORBIDDEN_NAMES = new Set([
  'uninstall.exe', 'installer.exe', 'uninstaller.exe', 'uninstall-manifest.json', 'install-config.json', 'install-receipt.json',
  'install-receipt.pending.json', 'install-state.json', 'payload.7z', '7zr.exe',
  'oxy-service.json', 'oxy-deployment.json', 'edition-identity.json', '.app-data',
  '.app-data.instance', '.git', '.env', 'devkit', 'plugin-sdk',
])

function runArchive(args, cwd) {
  const result = spawnSync(SEVENZ, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Error(`Portable archive failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Portable archive failed with exit ${result.status}`)
}

function validatePortablePath(name) {
  const segments = name.replaceAll('\\', '/').replace(/\/$/, '').split('/')
  if (segments.some(segment => !segment || segment === '..' || segment === '.' || /[:\x00]/.test(segment))) throw new Error(`Unexpected portable path: ${name}`)
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (FORBIDDEN_NAMES.has(lower) || lower.startsWith('.env.') || /^(?:sidekickai-)?setup.*\.exe$/i.test(segment) || /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(segment)) {
      throw new Error(`Portable input contains non-distributable content: ${name}`)
    }
  }
  if (/(?:^|\/)(?:better-sqlite3|uiohook-napi)\/(?:build|bin)(?:\/|$)/i.test(segments.join('/'))) throw new Error(`Portable input contains a development native build: ${name}`)
  if (segments.some(segment => segment.toLowerCase() === 'data')) throw new Error(`Portable input contains user data: ${name}`)
}
function readAt(fd, size, offset) {
  const bytes = Buffer.alloc(size)
  if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error('Truncated ZIP metadata')
  return bytes
}

function safeInteger(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('ZIP metadata exceeds the supported integer range')
  return number
}

function listZipEntries(zipPath) {
  const size = fs.statSync(zipPath).size
  const fd = fs.openSync(zipPath, 'r')
  try {
    const tailSize = Math.min(size, 65536 + 22)
    const tailOffset = size - tailSize
    const tail = readAt(fd, tailSize, tailOffset)
    let endOffset = -1
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        endOffset = offset
        break
      }
    }
    if (endOffset < 0) throw new Error('ZIP end directory is missing')
    if (tail.readUInt16LE(endOffset + 4) !== 0 || tail.readUInt16LE(endOffset + 6) !== 0) throw new Error('Multi-disk ZIP archives are not supported')
    let entryCount = tail.readUInt16LE(endOffset + 10)
    let directorySize = tail.readUInt32LE(endOffset + 12)
    let directoryOffset = tail.readUInt32LE(endOffset + 16)
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locatorOffset = tailOffset + endOffset - 20
      if (locatorOffset < 0) throw new Error('ZIP64 locator is missing')
      const locator = readAt(fd, 20, locatorOffset)
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new Error('Invalid ZIP64 locator')
      const recordOffset = safeInteger(locator.readBigUInt64LE(8))
      if (recordOffset + 56 > locatorOffset) throw new Error('ZIP64 directory record is outside the archive')
      const record = readAt(fd, 56, recordOffset)
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readBigUInt64LE(4) < 44n || record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw new Error('Invalid ZIP64 directory record')
      entryCount = safeInteger(record.readBigUInt64LE(32))
      directorySize = safeInteger(record.readBigUInt64LE(40))
      directoryOffset = safeInteger(record.readBigUInt64LE(48))
    }
    if (!entryCount || directoryOffset + directorySize > tailOffset + endOffset) throw new Error('Invalid ZIP central directory range')
    const directoryEnd = directoryOffset + directorySize
    const names = []
    let position = directoryOffset
    while (position < directoryEnd) {
      if (position + 46 > directoryEnd) throw new Error('Truncated ZIP central directory entry')
      const header = readAt(fd, 46, position)
      if (header.readUInt32LE(0) !== 0x02014b50) throw new Error('Invalid ZIP central directory entry')
      const nameSize = header.readUInt16LE(28)
      const extraSize = header.readUInt16LE(30)
      const commentSize = header.readUInt16LE(32)
      const next = position + 46 + nameSize + extraSize + commentSize
      if (next > directoryEnd) throw new Error('ZIP entry extends beyond the central directory')
      names.push(readAt(fd, nameSize, position + 46).toString('utf8').replaceAll('\\', '/'))
      position = next
    }
    if (names.length !== entryCount) throw new Error('ZIP entry count does not match the directory')
    return names
  } finally {
    fs.closeSync(fd)
  }
}

function verifyZip(zipPath, minimumSize = MIN_ZIP_BYTES) {
  u.assertFile(zipPath)
  const size = fs.statSync(zipPath).size
  const entries = listZipEntries(zipPath)
  const seen = new Set()
  for (const name of entries) {
    const key = name.toLowerCase().replace(/\/$/, '')
    if (seen.has(key)) throw new Error(`Duplicate portable ZIP path: ${name}`)
    seen.add(key)
    if (!name.startsWith(`${DIRECTORY_NAME}/`)) throw new Error(`Unexpected portable ZIP root: ${name}`)
    if (name === `${DIRECTORY_NAME}/` || name === `${DIRECTORY_NAME}/${LAYOUT.dataDirectory}/`) continue
    validatePortablePath(name)
  }
  for (const name of REQUIRED_ENTRIES) if (!entries.includes(name)) throw new Error(`Portable ZIP is missing ${name}`)
  if (size < minimumSize) throw new Error(`Portable ZIP is unexpectedly small: ${size} bytes; minimum ${minimumSize}`)
  runArchive(['t', zipPath], path.dirname(zipPath))
  console.log(`[pack-portable] Verified ${entries.length} ZIP entries (${(size / 1024 / 1024).toFixed(1)} MB)`)
  return { size, entries: entries.length, sha256: u.sha256(zipPath) }
}

function universalLauncher() {
  return [
    '@echo off',
    'setlocal',
    'set "SIDEKICK_ARCH=x64"',
    'if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "SIDEKICK_ARCH=arm64"',
    'if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "SIDEKICK_ARCH=arm64"',
    `set "SIDEKICK_TARGET=%~dp0${LAYOUT.runtimes.x64}\\${product.executable}"`,
    `if "%SIDEKICK_ARCH%"=="arm64" set "SIDEKICK_TARGET=%~dp0${LAYOUT.runtimes.arm64}\\${product.executable}"`,
    'if not exist "%SIDEKICK_TARGET%" (',
    '  echo Application runtime is missing. Extract the complete archive and try again.',
    '  exit /b 1',
    ')',
    'start "" "%SIDEKICK_TARGET%" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

function stagePortableApplication(source, destination, arch) {
  validateArchitectures([arch])
  const relative = path.relative(path.resolve(source), path.resolve(destination))
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Portable destination must be outside the source application directory')
  if (fs.existsSync(destination)) throw new Error(`Portable staging directory already exists: ${destination}`)
  const applicationInputs = applicationFingerprint(source)
  for (const entry of applicationInputs.entries) validatePortablePath(entry.path)
  for (const name of REQUIRED_RUNTIME_FILES) u.assertFile(path.join(source, name))
  if (u.peInfo(fs.readFileSync(path.join(source, product.executable))).arch !== arch) throw new Error(`Portable application architecture mismatch: ${arch}`)
  const archive = path.join(source, 'resources', 'app.asar')
  for (const name of asar.listPackage(archive)) validatePortablePath(name.replace(/^[\\/]+/, ''))
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString())
  if (packaged.name !== product.editions.concept.packageName || packaged.version !== VERSION) throw new Error('Portable application edition/version mismatch')
  const native = verifyPackagedNative(source, arch)
  const existingMarker = path.join(source, 'portable.txt')
  if (fs.existsSync(existingMarker)) {
    u.assertFile(existingMarker)
    if (fs.readFileSync(existingMarker, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] !== 'AI Window Portable Mode Marker') throw new Error('Unexpected source portable marker')
  }
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
  u.assertUnchanged(applicationInputs, applicationFingerprint(destination))
  fs.writeFileSync(path.join(destination, 'portable.txt'), MARKER)
  u.assertUnchanged(applicationInputs, applicationFingerprint(source))
  return { source, directory: destination, native, applicationInputs, inputs: applicationFingerprint(destination) }
}

function packPortable({ output, applications, architectures = ['x64', 'arm64'] }) {
  if (selection.edition !== 'concept' || !product.editions.concept.packageKinds.includes('portable')) throw new Error('Portable application distribution is only available for the concept edition')
  validateArchitectures(architectures)
  if (architectures.length !== 2 || !architectures.includes('x64') || !architectures.includes('arm64')) throw new Error('Portable distribution requires x64 and arm64 runtimes')
  if (!output || !applications) throw new Error('Portable output and application directories are required')
  output = path.resolve(output)
  applications = path.resolve(applications)
  u.assertFile(SEVENZ)
  const staging = path.join(output, 'portable-staging', 'universal')
  const directory = path.join(staging, DIRECTORY_NAME)
  const zip = path.join(output, `SidekickAI-Portable-${VERSION}-win.zip`)
  for (const target of [directory, zip, path.join(output, 'portable-evidence.json')]) {
    if (fs.existsSync(target)) throw new Error(`Portable output already exists: ${target}`)
  }
  const applicationInputs = {}
  for (const arch of ['x64', 'arm64']) {
    const source = path.join(applications, LAYOUT.runtimes[arch])
    const staged = stagePortableApplication(source, path.join(directory, LAYOUT.runtimes[arch]), arch)
    applicationInputs[arch] = staged.applicationInputs
  }
  fs.mkdirSync(path.join(directory, LAYOUT.dataDirectory))
  fs.writeFileSync(path.join(directory, LAYOUT.launcher), universalLauncher(), { flag: 'wx' })
  fs.writeFileSync(path.join(directory, 'portable-layout.json'), JSON.stringify(LAYOUT, null, 2) + '\n', { flag: 'wx' })
  const runtimeInputs = applicationFingerprint(directory)
  const manifest = {
    schemaVersion: 1, edition: 'concept', name: product.name, version: VERSION,
    architectures: ['x64', 'arm64'], packageKind: 'portable',
    files: runtimeInputs.entries,
  }
  fs.writeFileSync(path.join(directory, 'portable-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const inputs = applicationFingerprint(directory)
  runArchive(['a', '-tzip', '-mx=5', '-y', zip, DIRECTORY_NAME], staging)
  const verification = verifyZip(zip)
  u.assertUnchanged(inputs, applicationFingerprint(directory))
  for (const arch of architectures) u.assertUnchanged(applicationInputs[arch], applicationFingerprint(path.join(applications, LAYOUT.runtimes[arch])))
  const artifacts = [{ arch: 'universal', path: zip, ...verification, directory, applicationInputs, inputs }]
  fs.writeFileSync(path.join(output, 'portable-evidence.json'), JSON.stringify(artifacts, null, 2) + '\n', { flag: 'wx' })
  return artifacts
}

function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === '--output-dir' ? '--applications' : args[index]
    if (!['--applications', '--output'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || options[key]) throw new Error('Usage: pack-portable.cjs --applications <directory> [--output <new-directory>]')
    options[key] = args[index + 1]
  }
  if (!options['--applications']) throw new Error('A shared application build directory is required (--applications)')
  return packPortable({
    applications: path.resolve(options['--applications']),
    output: options['--output'] ? path.resolve(options['--output']) : u.uniqueOutput(path.join(ROOT, 'dist-portable')),
  })
}

module.exports = { listZipEntries, verifyZip, universalLauncher, validatePortablePath, stagePortableApplication, packPortable, main, REQUIRED_ENTRIES, REQUIRED_RUNTIME_FILES }
if (require.main === module) {
  require('./packaging-lock.cjs').withPackagingLock(() => main()).catch(error => {
    console.error(`[pack-portable] Failed: ${error.stack || error}`)
    process.exitCode = 1
  })
}
