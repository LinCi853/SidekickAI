'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const esbuild = require('esbuild')
const u = require('./build-utils.cjs')
const root = path.resolve(__dirname, '..')
const COMPONENT_PATH = 'resources/host-backup/component.json'

function identity(architecture) {
  if (!['x64', 'arm64'].includes(architecture))
    throw new Error('Unsupported host backup architecture')
  return {
    productId: require('../contracts/distribution-product.json').productId,
    edition: require('../product-edition.json').edition,
    productVersion: require('../package.json').version,
    architecture,
  }
}

function desktopBoundary() {
  return {
    name: 'host-backup-desktop-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/(?:sessions|sensitive-drafts)\.js$/ }, (args) => {
        if (
          path.resolve(args.importer) !== path.join(root, 'packages/backup-core/export.ts') ||
          args.kind !== 'dynamic-import'
        )
          return undefined
        return { path: args.path, namespace: 'host-backup-desktop-boundary' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'host-backup-desktop-boundary' }, () => ({
        contents: `function unavailable(){throw new Error('Independent backup preserves raw protected data; desktop conversion is unavailable.')} export const captureBackupSessions=unavailable; export const captureOfflineSensitiveData=unavailable; export const captureBackupDrafts=unavailable;`,
        loader: 'js',
      }))
    },
  }
}

function assertIndependentImports(metadata) {
  const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
  for (const generated of Object.values(metadata.outputs)) {
    if (generated.imports.some((item) => !builtins.has(item.path.replace(/^node:/, ''))))
      throw new Error('Host backup contains an external application dependency')
  }
}

async function bundle(architecture) {
  const output = await esbuild.build({
    stdin: {
      contents: `import {runBackupComponent,encodeResponse} from './packages/backup-core/component'; runBackupComponent(process.stdin,${JSON.stringify(identity(architecture))}).then(response=>{process.stdout.write(encodeResponse(response)+'\\n');process.exitCode=response.success?0:1});`,
      resolveDir: root,
    },
    absWorkingDir: root,
    plugins: [desktopBoundary()],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    write: false,
    metafile: true,
    logLevel: 'warning',
  })
  assertIndependentImports(output.metafile)
  return output
}

function bundledNotices(metadata) {
  const directories = new Set()
  for (const input of Object.keys(metadata.inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
    let directory = path.dirname(path.resolve(root, input))
    while (directory !== root && !fs.existsSync(path.join(directory, 'package.json')))
      directory = path.dirname(directory)
    if (directory !== root) directories.add(directory)
  }
  return [...directories]
    .sort()
    .map((directory) => {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      const licenses = fs
        .readdirSync(directory)
        .filter((name) => /^(license|copying)(\.|$)/i.test(name))
      if (!licenses.length) throw new Error(`Missing redistribution license: ${pkg.name}`)
      return `${pkg.name} ${pkg.version} (${pkg.license || 'See license'})\n\n${licenses.map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n')}\n`
    })
    .join('\n----------------------------------------\n\n')
}

function verifyNode(file, architecture) {
  u.assertFile(file)
  const contract = require('../packages/backup-core/runtime-manifest.json')
  if (
    u.sha256(file) !== contract.architectures[architecture] ||
    u.peInfo(fs.readFileSync(file)).arch !== architecture
  )
    throw new Error('Pinned host backup Node runtime mismatch')
}

async function runtime(architecture, cacheRoot = process.env.SIDEKICK_BACKUP_RUNTIME_CACHE) {
  const contract = require('../packages/backup-core/runtime-manifest.json')
  const local = path.join(root, 'build/host-backup-runtime', architecture)
  const candidates = [cacheRoot && path.resolve(cacheRoot, architecture), local].filter(Boolean)
  for (const directory of candidates) {
    const file = path.join(directory, 'node.exe')
    if (!fs.existsSync(file)) continue
    verifyNode(file, architecture)
    const license = path.join(directory, 'LICENSE.txt')
    u.assertFile(license)
    return { executable: file, license }
  }
  fs.mkdirSync(local, { recursive: true })
  const executable = path.join(local, 'node.exe')
  const temporary = executable + '.download'
  try {
    const response = await fetch(
      `https://nodejs.org/dist/v${contract.nodeVersion}/win-${architecture}/node.exe`,
    )
    if (!response.ok || !response.body)
      throw new Error('Cannot download pinned host backup runtime')
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, { flags: 'wx' }),
    )
    verifyNode(temporary, architecture)
    const licenseResponse = await fetch(
      `https://raw.githubusercontent.com/nodejs/node/v${contract.nodeVersion}/LICENSE`,
    )
    if (!licenseResponse.ok) throw new Error('Cannot obtain Node redistribution license')
    const license = path.join(local, 'LICENSE.txt')
    fs.writeFileSync(license, await licenseResponse.text(), { flag: 'wx' })
    fs.renameSync(temporary, executable)
    return { executable, license }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function descriptorMetadata(architecture) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    ...identity(architecture),
    executable: 'node.exe',
    arguments: ['backup-component.cjs'],
    operations: ['describe', 'export', 'verify', 'decrypt', 'restore'],
    formats: [
      { id: 'zip', extension: 'zip', encrypted: false, label: 'ZIP' },
      {
        id: 'sabackup',
        extension: 'sabackup',
        encrypted: true,
        label: '加密备份',
      },
    ],
    options: [
      { id: 'basicData', label: '基础数据', required: true, default: true },
      { id: 'cookies', label: '登录状态', required: false, default: true },
      {
        id: 'indexedDB',
        label: '离线网页数据',
        required: false,
        default: true,
      },
      { id: 'cache', label: '缓存', required: false, default: false },
    ],
  }
}

function verifyComponent(directory, architecture) {
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'component.json'), 'utf8'))
  const { files, ...metadata } = descriptor
  if (
    JSON.stringify(metadata) !== JSON.stringify(descriptorMetadata(architecture)) ||
    !Array.isArray(files) ||
    !files.length
  )
    throw new Error('Invalid host backup descriptor')
  const expected = new Set([
    'node.exe',
    'backup-component.cjs',
    'LICENSE.node.txt',
    'LICENSE.application.txt',
    'THIRD-PARTY-NOTICES.txt',
  ])
  for (const file of files) {
    if (Object.keys(file).sort().join('|') !== 'path|sha256|size' || !expected.delete(file.path))
      throw new Error('Invalid host backup closure')
    const target = path.join(directory, file.path)
    u.assertFile(target)
    if (fs.statSync(target).size !== file.size || u.sha256(target) !== file.sha256)
      throw new Error('Host backup file identity mismatch')
  }
  if (expected.size || u.listFiles(directory, new Set()).length !== files.length + 1)
    throw new Error('Incomplete host backup closure')
  verifyNode(path.join(directory, 'node.exe'), architecture)
  return descriptor
}

async function buildComponent(directory, architecture, settings = {}) {
  const binaries = await runtime(architecture, settings.runtimeCache)
  const output = await bundle(architecture)
  if (fs.existsSync(directory)) throw new Error('Host backup output already exists')
  fs.mkdirSync(directory, { recursive: true })
  fs.copyFileSync(binaries.executable, path.join(directory, 'node.exe'), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(
    binaries.license,
    path.join(directory, 'LICENSE.node.txt'),
    fs.constants.COPYFILE_EXCL,
  )
  fs.copyFileSync(
    path.join(root, 'LICENSE'),
    path.join(directory, 'LICENSE.application.txt'),
    fs.constants.COPYFILE_EXCL,
  )
  fs.writeFileSync(path.join(directory, 'backup-component.cjs'), output.outputFiles[0].contents, {
    flag: 'wx',
  })
  fs.writeFileSync(
    path.join(directory, 'THIRD-PARTY-NOTICES.txt'),
    bundledNotices(output.metafile),
    { flag: 'wx' },
  )
  const files = u.listFiles(directory, new Set()).map((file) => ({
    path: path.basename(file),
    size: fs.statSync(file).size,
    sha256: u.sha256(file),
  }))
  fs.writeFileSync(
    path.join(directory, 'component.json'),
    JSON.stringify({ ...descriptorMetadata(architecture), files }, null, 2) + '\n',
    { flag: 'wx' },
  )
  return verifyComponent(directory, architecture)
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const architecture =
    typeof context.arch === 'string' ? context.arch : { 1: 'x64', 3: 'arm64' }[context.arch]
  await buildComponent(path.join(context.appOutDir, 'resources/host-backup'), architecture)
  const product = require('../contracts/distribution-product.json')
  if (product.backupComponent !== COMPONENT_PATH)
    throw new Error('Application backup component declaration mismatch')
  fs.writeFileSync(
    path.join(context.appOutDir, 'resources/product-descriptor.json'),
    JSON.stringify(product, null, 2) + '\n',
    { flag: 'wx' },
  )
}

module.exports = {
  COMPONENT_PATH,
  identity,
  bundle,
  buildComponent,
  verifyComponent,
  afterPack,
  assertIndependentImports,
}
if (require.main === module) {
  const architecture = process.argv[2] || process.arch
  const directory = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(root, 'build/host-backup', architecture)
  buildComponent(directory, architecture)
    .then(() => console.log(directory))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
