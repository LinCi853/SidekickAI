'use strict'

const fs = require('node:fs')
const path = require('node:path')
const u = require('./build-utils.cjs')
const {
  ROOT,
  VERSION,
  REQUIRED_RUNTIME_FILES,
  validateArchitectures,
  applicationFingerprint,
  verifyRuntime,
  verifyNativeFiles,
} = require('./application-packaging.cjs')
const product = require('../packages/product-contract/manifest.json')
const selection = require('../product-edition.json')
const runtime = require('./application-runtime.cjs')

const DIRECTORY_NAME = product.name
const LAYOUT = product.portable
// 单架构便携包：应用目录即包根，数据目录位于应用目录内（应用原生单目录便携模式）
const SINGLE_MARKER = 'AI Window Portable Mode Marker\n'
const MIN_ZIP_BYTES = 90 * 1024 * 1024
const UNINSTALLER_FILES = ['uninstall.exe', 'uninstall-manifest.json']
// A portable user has no installation record, so the archive ships its own uninstaller at the
// application root to remove data, cache and registry residue. It is a required component, not
// installation-flow metadata.
const REQUIRED_ENTRIES = [
  `${DIRECTORY_NAME}/${product.executable}`,
  `${DIRECTORY_NAME}/resources/app.asar`,
  `${DIRECTORY_NAME}/portable.txt`,
  `${DIRECTORY_NAME}/uninstall.exe`,
  `${DIRECTORY_NAME}/uninstall-manifest.json`,
]
// Installation-flow metadata would make the green package depend on an installation record.
const INSTALLATION_METADATA = [
  'lifecycle-package.json',
  'maintenance/installation-configuration.json',
  'resources/installation-contract.json',
]
// Maintenance-period runtime: used only by the install/uninstall flow through the product
// descriptor, so the green package does not distribute it.
const MAINTENANCE_RUNTIME = 'resources/host-backup'
function validatePortablePath(name) {
  const normalized = name.replaceAll('\\', '/').replace(/\/$/, '')
  const relative = normalized.startsWith(`${DIRECTORY_NAME}/`)
    ? normalized.slice(DIRECTORY_NAME.length + 1)
    : normalized
  // Only the application-root uninstaller pair is accepted; every other path keeps the general
  // rules, so maintenance tools, install receipts and runtime user data stay rejected.
  if (UNINSTALLER_FILES.includes(relative)) return normalized
  return runtime.validateSoftwarePath(normalized)
}

function readAt(fd, size, offset) {
  const bytes = Buffer.alloc(size)
  if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error('Truncated ZIP metadata')
  return bytes
}

function safeInteger(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error('ZIP metadata exceeds the supported integer range')
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
      if (
        tail.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
      ) {
        endOffset = offset
        break
      }
    }
    if (endOffset < 0) throw new Error('ZIP end directory is missing')
    if (tail.readUInt16LE(endOffset + 4) !== 0 || tail.readUInt16LE(endOffset + 6) !== 0)
      throw new Error('Multi-disk ZIP archives are not supported')
    let entryCount = tail.readUInt16LE(endOffset + 10)
    let directorySize = tail.readUInt32LE(endOffset + 12)
    let directoryOffset = tail.readUInt32LE(endOffset + 16)
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locatorOffset = tailOffset + endOffset - 20
      if (locatorOffset < 0) throw new Error('ZIP64 locator is missing')
      const locator = readAt(fd, 20, locatorOffset)
      if (
        locator.readUInt32LE(0) !== 0x07064b50 ||
        locator.readUInt32LE(4) !== 0 ||
        locator.readUInt32LE(16) !== 1
      )
        throw new Error('Invalid ZIP64 locator')
      const recordOffset = safeInteger(locator.readBigUInt64LE(8))
      if (recordOffset + 56 > locatorOffset)
        throw new Error('ZIP64 directory record is outside the archive')
      const record = readAt(fd, 56, recordOffset)
      if (
        record.readUInt32LE(0) !== 0x06064b50 ||
        record.readBigUInt64LE(4) < 44n ||
        record.readUInt32LE(16) !== 0 ||
        record.readUInt32LE(20) !== 0
      )
        throw new Error('Invalid ZIP64 directory record')
      entryCount = safeInteger(record.readBigUInt64LE(32))
      directorySize = safeInteger(record.readBigUInt64LE(40))
      directoryOffset = safeInteger(record.readBigUInt64LE(48))
    }
    if (!entryCount || directoryOffset + directorySize > tailOffset + endOffset)
      throw new Error('Invalid ZIP central directory range')
    const directoryEnd = directoryOffset + directorySize
    const names = []
    let position = directoryOffset
    while (position < directoryEnd) {
      if (position + 46 > directoryEnd) throw new Error('Truncated ZIP central directory entry')
      const header = readAt(fd, 46, position)
      if (header.readUInt32LE(0) !== 0x02014b50)
        throw new Error('Invalid ZIP central directory entry')
      const nameSize = header.readUInt16LE(28)
      const extraSize = header.readUInt16LE(30)
      const commentSize = header.readUInt16LE(32)
      const next = position + 46 + nameSize + extraSize + commentSize
      if (next > directoryEnd) throw new Error('ZIP entry extends beyond the central directory')
      names.push(
        readAt(fd, nameSize, position + 46)
          .toString('utf8')
          .replaceAll('\\', '/'),
      )
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
    if (!name.startsWith(`${DIRECTORY_NAME}/`))
      throw new Error(`Unexpected portable ZIP root: ${name}`)
    if (name === `${DIRECTORY_NAME}/` || name === `${DIRECTORY_NAME}/${LAYOUT.dataDirectory}/`)
      continue
    validatePortablePath(name)
  }
  for (const name of REQUIRED_ENTRIES)
    if (!entries.includes(name)) throw new Error(`Portable ZIP is missing ${name}`)
  if (size < minimumSize)
    throw new Error(`Portable ZIP is unexpectedly small: ${size} bytes; minimum ${minimumSize}`)
  runtime.verifyArchive(zipPath)
  console.log(
    `[pack-portable] Verified ${entries.length} ZIP entries (${(size / 1024 / 1024).toFixed(1)} MB)`,
  )
  return { size, entries: entries.length, sha256: u.sha256(zipPath) }
}

function assertNoInstallerElements(directory) {
  // A portable archive ships the source build as-is. Installation-flow metadata would make the
  // green package depend on an installation record, so its presence is a hard failure. The
  // bundled uninstaller is injected from the lifecycle toolkit and is not part of this check.
  for (const relative of INSTALLATION_METADATA) {
    if (fs.existsSync(path.join(directory, ...relative.split('/'))))
      throw new Error(`Portable source contains installation metadata: ${relative}`)
  }
}

function isMaintenanceRuntime(relative) {
  return relative === MAINTENANCE_RUNTIME || relative.startsWith(MAINTENANCE_RUNTIME + '/')
}

function withoutMaintenanceRuntime(fingerprint) {
  const entries = fingerprint.entries.filter((entry) => !isMaintenanceRuntime(entry.path))
  return { fingerprint: u.hash(JSON.stringify(entries)), entries }
}

function stagePortableApplication(source, destination, arch, { uninstaller } = {}) {
  validateArchitectures([arch])
  const relative = path.relative(path.resolve(source), path.resolve(destination))
  if (
    !relative ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    throw new Error('Portable destination must be outside the source application directory')
  if (fs.existsSync(destination))
    throw new Error(`Portable staging directory already exists: ${destination}`)
  const applicationInputs = applicationFingerprint(source)
  const { native } = verifyRuntime(source, arch, { allowPortable: true })
  verifyNativeFiles(source, arch)
  assertNoInstallerElements(source)
  const existingMarker = path.join(source, 'portable.txt')
  if (fs.existsSync(existingMarker)) {
    u.assertFile(existingMarker)
    if (
      fs
        .readFileSync(existingMarker, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/, 1)[0] !== 'AI Window Portable Mode Marker'
    )
      throw new Error('Unexpected source portable marker')
  }
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (file) => {
      const relative = path.relative(source, file).replaceAll('\\', '/')
      return !relative || !isMaintenanceRuntime(relative)
    },
  })
  u.assertUnchanged(
    withoutMaintenanceRuntime(applicationInputs),
    applicationFingerprint(destination),
  )
  if (uninstaller) {
    for (const name of UNINSTALLER_FILES)
      fs.copyFileSync(
        path.join(uninstaller, name),
        path.join(destination, name),
        fs.constants.COPYFILE_EXCL,
      )
  }
  fs.writeFileSync(path.join(destination, 'portable.txt'), SINGLE_MARKER)
  u.assertUnchanged(applicationInputs, applicationFingerprint(source))
  return {
    source,
    directory: destination,
    native,
    applicationInputs,
    inputs: applicationFingerprint(destination),
  }
}

// 待后统一：工具包尚无便携包专用接口，这里直接读取既有的按版本/架构卸载器目录；
// 工具包结构本身不做改动，后续统一入口时再替换这段读取。
function portableUninstaller(toolkit, arch) {
  if (!toolkit || !toolkit.directory)
    throw new Error('Portable packaging requires the prepared lifecycle toolkit')
  const directory = path.join(toolkit.directory, 'uninstallers', selection.edition, arch)
  const executable = path.join(directory, 'uninstall.exe')
  const manifestPath = path.join(directory, 'uninstall-manifest.json')
  u.assertFile(executable)
  u.assertFile(manifestPath)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (
    manifest.protocolVersion !== 3 ||
    manifest.edition !== selection.edition ||
    manifest.arch !== arch
  )
    throw new Error('Portable uninstaller manifest does not match this edition and architecture')
  if (manifest.size !== fs.statSync(executable).size || manifest.sha256 !== u.sha256(executable))
    throw new Error('Portable uninstaller does not match its manifest')
  return directory
}

function packPortableArchitecture({ output, applications, arch, minimumZipBytes, uninstaller }) {
  const staging = path.join(output, 'portable-staging', arch)
  const directory = path.join(staging, DIRECTORY_NAME)
  const zip = path.join(output, `SidekickAI-Portable-${VERSION}-${arch}-win.zip`)
  for (const target of [directory, zip]) {
    if (fs.existsSync(target)) throw new Error('Portable output already exists: ' + target)
  }
  const source = path.join(applications, LAYOUT.runtimes[arch])
  const staged = stagePortableApplication(source, directory, arch, { uninstaller })
  fs.mkdirSync(path.join(directory, LAYOUT.dataDirectory), { recursive: true })
  const manifest = {
    schemaVersion: 1,
    edition: selection.edition,
    name: product.name,
    version: VERSION,
    architectures: [arch],
    packageKind: 'portable',
    contents: {
      uninstaller: '绿色包自带卸载器，用于清理数据目录、缓存与注册表残留',
      excludedMaintenanceRuntime:
        'resources/host-backup 是维护期运行时，仅安装/卸载流程使用，不随绿色包分发',
    },
    files: runtime.fileInventory(directory, { validate: validatePortablePath }),
  }
  fs.writeFileSync(
    path.join(directory, 'portable-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  )
  const inputs = applicationFingerprint(directory)
  runtime.archiveFiles(
    staging,
    zip,
    runtime.fileInventory(directory, {
      prefix: DIRECTORY_NAME + '/',
      validate: validatePortablePath,
    }),
    { emptyDirectories: [DIRECTORY_NAME + '/' + LAYOUT.dataDirectory] },
  )
  const verification = verifyZip(zip, minimumZipBytes)
  u.assertUnchanged(inputs, applicationFingerprint(directory))
  u.assertUnchanged(staged.applicationInputs, applicationFingerprint(source))
  return {
    arch,
    path: zip,
    ...verification,
    directory,
    applicationInputs: staged.applicationInputs,
    inputs,
  }
}

async function packPortable({
  output,
  applications,
  architectures = ['x64', 'arm64'],
  minimumZipBytes = MIN_ZIP_BYTES,
  toolkit,
}) {
  validateArchitectures(architectures)
  if (!output || !applications)
    throw new Error('Portable output and application directories are required')
  output = path.resolve(output)
  applications = path.resolve(applications)
  if (fs.existsSync(path.join(output, 'portable-evidence.json')))
    throw new Error(
      'Portable output already exists: ' + path.join(output, 'portable-evidence.json'),
    )
  const prepared = toolkit || (await require('./distribution-toolkit.cjs').prepareToolkit(ROOT))
  const applicationInputs = {}
  const artifacts = []
  for (const arch of architectures) {
    const artifact = packPortableArchitecture({
      output,
      applications,
      arch,
      minimumZipBytes,
      uninstaller: portableUninstaller(prepared, arch),
    })
    applicationInputs[arch] = artifact.applicationInputs
    artifacts.push(artifact)
  }
  fs.writeFileSync(
    path.join(output, 'portable-evidence.json'),
    JSON.stringify(artifacts, null, 2) + '\n',
    { flag: 'wx' },
  )
  return artifacts
}

async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === '--output-dir' ? '--applications' : args[index]
    if (
      !['--applications', '--output'].includes(key) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--') ||
      options[key]
    )
      throw new Error(
        'Usage: pack-portable.cjs --applications <directory> [--output <new-directory>]',
      )
    options[key] = args[index + 1]
  }
  if (!options['--applications'])
    throw new Error('A shared application build directory is required (--applications)')
  const output = options['--output']
    ? path.resolve(options['--output'])
    : u.uniqueOutput(path.join(ROOT, 'build/portable-runs'))
  return packPortable({ applications: path.resolve(options['--applications']), output })
}

module.exports = {
  listZipEntries,
  verifyZip,
  validatePortablePath,
  stagePortableApplication,
  packPortable,
  main,
  REQUIRED_ENTRIES,
  REQUIRED_RUNTIME_FILES,
}
if (require.main === module) {
  require('./packaging-lock.cjs')
    .withPackagingLock(() => main())
    .catch((error) => {
      console.error(`[pack-portable] Failed: ${error.stack || error}`)
      process.exitCode = 1
    })
}
