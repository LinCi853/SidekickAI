'use strict'

// scripts/portable-uninstall-contract.cjs —— 绿色包便携卸载契约
//
// 通用卸载器按固定约定识别绿色包：包根的 portable.txt 标记文件，加上包内的
// maintenance/portable.json 清单。清单声明产品身份、是否拥有安装根、数据根和
// 注册项；卸载器只按清单删除，缺任一文件或清单不合规则拒绝正常卸载，不猜。
//
// 本模块是契约的唯一实现：打包脚本按它写入文件，校验脚本按它核对字节。

const fs = require('node:fs')
const path = require('node:path')

const CONTRACT_FILE = 'contracts/portable-uninstall-contract.json'
const MANIFEST_KIND = 'portable-manifest'
const SCHEMA_VERSION = 1
const SCOPES = new Set(['install-root', 'appdata', 'localappdata'])
const VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PRODUCT_ID = /^[a-z0-9][a-z0-9._-]*$/i
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function exact(value, keys, label) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    throw new Error('Invalid portable ' + label)
  return value
}

// 数据根路径规则：写在安装目录内的数据用相对路径，写在用户目录的数据用相对该根的
// 单段目录名；不接受绝对路径、盘符、越界路径与保留设备名。
function validateDataRootPath(scope, value) {
  if (!SCOPES.has(scope)) throw new Error('Unknown portable data root scope: ' + scope)
  if (typeof value !== 'string' || !value) throw new Error('Invalid portable data root path')
  if (/[\\:]/.test(value) || value.startsWith('/'))
    throw new Error('Portable data root path must be relative: ' + value)
  const segments = value.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..')
      throw new Error('Portable data root path escapes its root: ' + value)
    if (/[. ]$/.test(segment) || RESERVED.test(segment) || /[\x00-\x1f\x7f<>"*?|]/.test(segment))
      throw new Error('Unsafe portable data root path: ' + value)
  }
  if (scope !== 'install-root' && segments.length !== 1)
    throw new Error('User scope portable data roots must be one directory name: ' + value)
  return value
}

function validateDataRoots(dataRoots, label) {
  if (!Array.isArray(dataRoots)) throw new Error('Invalid portable ' + label)
  for (const root of dataRoots) {
    exact(root, ['scope', 'path', 'recursive'], label + ' fields')
    validateDataRootPath(root.scope, root.path)
    if (root.recursive !== true) throw new Error('Portable data roots must be removed recursively')
  }
  return dataRoots
}

function validateRegistrations(registrations, label) {
  if (!Array.isArray(registrations)) throw new Error('Invalid portable ' + label)
  for (const entry of registrations) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object')
      throw new Error('Invalid portable ' + label)
  }
  return registrations
}

function validateContract(contract) {
  exact(
    contract,
    [
      'schemaVersion',
      'kind',
      'marker',
      'manifest',
      'product',
      'rootOwned',
      'dataRoots',
      'registrations',
    ],
    'uninstall contract fields',
  )
  if (contract.schemaVersion !== SCHEMA_VERSION || contract.kind !== 'portable-uninstall-contract')
    throw new Error('Invalid portable uninstall contract')
  exact(contract.marker, ['path', 'content'], 'marker fields')
  if (contract.marker.path !== 'portable.txt' || contract.marker.content !== 'portable')
    throw new Error('Invalid portable marker declaration')
  exact(contract.manifest, ['path', 'schemaVersion', 'kind'], 'manifest fields')
  if (
    contract.manifest.path !== 'maintenance/portable.json' ||
    contract.manifest.schemaVersion !== SCHEMA_VERSION ||
    contract.manifest.kind !== MANIFEST_KIND
  )
    throw new Error('Invalid portable manifest declaration')
  exact(contract.product, ['productId'], 'product fields')
  if (!PRODUCT_ID.test(contract.product.productId))
    throw new Error('Invalid portable product identity')
  if (typeof contract.rootOwned !== 'boolean') throw new Error('Invalid portable root ownership')
  validateDataRoots(contract.dataRoots, 'data roots')
  validateRegistrations(contract.registrations, 'registrations')
  return contract
}

// 契约与产品身份、应用数据目录必须一致，避免清单声明和实际运行分家。
// 绿色包按版别身份标识自己（概念版 sidekickai-opensource），卸载器据此区分路线。
function loadContract(root = path.resolve(__dirname, '..')) {
  const contract = validateContract(
    JSON.parse(fs.readFileSync(path.join(root, CONTRACT_FILE), 'utf8')),
  )
  const selection = JSON.parse(fs.readFileSync(path.join(root, 'product-edition.json'), 'utf8'))
  const descriptor = JSON.parse(
    fs.readFileSync(path.join(root, 'contracts/distribution-product.json'), 'utf8'),
  )
  const edition = descriptor.editions?.[selection.edition]
  if (!edition) throw new Error('Unknown product edition for the portable uninstall contract')
  if (edition.packageName !== contract.product.productId)
    throw new Error('Portable product identity differs from the distribution edition identity')
  const product = require('../packages/product-contract/manifest.json')
  const application = product.editions?.[selection.edition]
  if (!application || application.packageName !== contract.product.productId)
    throw new Error('Portable product identity differs from the application edition identity')
  const dataRoot = contract.dataRoots.find((entry) => entry.scope === 'install-root')
  if (!dataRoot || dataRoot.path !== product.portable.dataDirectory)
    throw new Error('Portable data root differs from the application data directory')
  return contract
}

function validateManifest(manifest) {
  exact(
    manifest,
    ['schemaVersion', 'kind', 'product', 'rootOwned', 'dataRoots', 'registrations'],
    'manifest fields',
  )
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== MANIFEST_KIND)
    throw new Error('Invalid portable manifest identity')
  exact(manifest.product, ['productId', 'version'], 'manifest product fields')
  if (!PRODUCT_ID.test(manifest.product.productId))
    throw new Error('Invalid portable manifest product identity')
  if (
    typeof manifest.product.version !== 'string' ||
    manifest.product.version.length > 64 ||
    !VERSION.test(manifest.product.version)
  )
    throw new Error('Invalid portable manifest product version')
  if (typeof manifest.rootOwned !== 'boolean')
    throw new Error('Invalid portable manifest root ownership')
  validateDataRoots(manifest.dataRoots, 'manifest data roots')
  validateRegistrations(manifest.registrations, 'manifest registrations')
  return manifest
}

function buildManifest(contract, version) {
  if (typeof version !== 'string' || version.length > 64 || !VERSION.test(version))
    throw new Error('Invalid portable product version')
  return validateManifest({
    schemaVersion: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    product: { productId: contract.product.productId, version },
    rootOwned: contract.rootOwned,
    dataRoots: contract.dataRoots.map((root) => ({
      scope: root.scope,
      path: root.path,
      recursive: root.recursive,
    })),
    registrations: contract.registrations.map((entry) => ({ ...entry })),
  })
}

function markerBytes(contract) {
  return Buffer.from(contract.marker.content, 'utf8')
}

function manifestBytes(manifest) {
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

// 写入绿色包的契约文件：包根标记与包内清单，两者必须同时存在。
function writePackageContract(packageRoot, { contract, version }) {
  const manifest = buildManifest(contract, version)
  fs.mkdirSync(path.join(packageRoot, path.dirname(contract.manifest.path)), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, contract.marker.path), markerBytes(contract))
  fs.writeFileSync(path.join(packageRoot, contract.manifest.path), manifestBytes(manifest), {
    flag: 'wx',
  })
  return manifest
}

// 核对已生成或已导入的绿色包：标记与清单必须逐字节符合项目契约，缺一即拒绝。
function verifyPackageContract(packageRoot, { contract, version }) {
  const marker = path.join(packageRoot, contract.marker.path)
  const manifestPath = path.join(packageRoot, contract.manifest.path)
  if (!fs.existsSync(marker)) throw new Error('Portable marker is missing: ' + contract.marker.path)
  if (!fs.existsSync(manifestPath))
    throw new Error('Portable uninstall manifest is missing: ' + contract.manifest.path)
  const expected = manifestBytes(buildManifest(contract, version))
  const actual = fs.readFileSync(manifestPath)
  if (!actual.equals(expected))
    throw new Error('Portable uninstall manifest differs from the project contract')
  if (!fs.readFileSync(marker).equals(markerBytes(contract)))
    throw new Error('Portable marker differs from the project contract')
  return validateManifest(JSON.parse(actual.toString('utf8')))
}

module.exports = {
  CONTRACT_FILE,
  MANIFEST_KIND,
  SCHEMA_VERSION,
  SCOPES,
  buildManifest,
  loadContract,
  manifestBytes,
  markerBytes,
  validateContract,
  validateDataRootPath,
  validateManifest,
  verifyPackageContract,
  writePackageContract,
}
