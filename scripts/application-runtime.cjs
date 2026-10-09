'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const u = require('./build-utils.cjs')

const FORBIDDEN_NAMES = new Set([
  'uninstall.exe', 'installer.exe', 'uninstaller.exe', 'recover.exe', 'maintenance',
  'uninstall-manifest.json', 'install-config.json', 'install-receipt.json', 'install-receipt.pending.json',
  'install-state.json', 'payload.7z', '7zr.exe', 'backup-runtime.zip', 'runtime-proof.json',
  'distribution-proof.json', 'body-proof.json', 'oxy-deployment.json', 'edition-identity.json',
  '.app-data', '.app-data.instance', '.git', '.env', 'devkit', 'plugin-sdk',
])

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  throw new Error('Unsupported application JSON value')
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 240 || /[\\:<>"|?*\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Unsafe application path')
  return value
}

function validateSoftwarePath(value) {
  validateRelativePath(value)
  const segments = value.split('/')
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    const publicService = /^(?:(?:SidekickAI\/)?(?:win-unpacked|win-arm64-unpacked)\/)?resources\/oxy-service\.json$/.test(value)
    if (FORBIDDEN_NAMES.has(lower) || lower === 'oxy-service.json' && !publicService || lower.startsWith('.env.')
      || /^(?:sidekickai-)?setup.*\.exe$/i.test(segment) || /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(segment)) {
      throw new Error(`Application input contains non-distributable content: ${value}`)
    }
  }
  if (/(?:^|\/)(?:better-sqlite3|uiohook-napi)\/(?:build|bin)(?:\/|$)/i.test(value)) throw new Error(`Application input contains a development native build: ${value}`)
  if (segments.some(segment => segment.toLowerCase() === 'data')) throw new Error(`Application input contains user data: ${value}`)
  return value
}

function fileInventory(directory, { prefix = '', validate = validateSoftwarePath } = {}) {
  const seen = new Set()
  return u.listFiles(directory, new Set()).map(file => {
    const name = prefix + path.relative(directory, file).replaceAll('\\', '/')
    validate(name)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate application path')
    seen.add(key)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Application files must be regular files')
    return { path: name, size: stat.size, sha256: u.sha256(file) }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

function applicationConfiguration(root = path.resolve(__dirname, '..'), env = process.env) {
  const cloud = require('./oxy-build-config.cjs').cloudBuildEnvironment(env, path.join(root, 'resources/oxy-deployment.json'))
  return { origin: cloud.SIDEKICK_OXY_ORIGIN, keys: JSON.parse(cloud.SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON),
    resourceKeys: JSON.parse(cloud.SIDEKICK_RESOURCE_TRUST_KEYS_JSON) }
}

function writeApplicationConfiguration(directory, configuration) {
  const resources = path.join(directory, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  for (const [name, value] of Object.entries({ 'application-trust.json': configuration.keys,
    'resource-trust.json': configuration.resourceKeys, 'oxy-service.json': { origin: configuration.origin } })) {
    fs.writeFileSync(path.join(resources, name), canonicalJson(value) + '\n', { flag: 'wx' })
  }
}

function runArchive(args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'application-archive.cjs'), ...args],
    { stdio: 'pipe', encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Application archive failed: ' + (result.error?.message || result.stderr.trim() || result.status))
}

function verifyArchive(archive, files, { emptyDirectories = [] } = {}) {
  u.assertFile(archive)
  let list
  try {
    if (files) {
      list = path.join(path.dirname(archive), '.archive-' + require('node:crypto').randomUUID() + '.json')
      fs.writeFileSync(list, JSON.stringify({ files, emptyDirectories }), { flag: 'wx' })
    }
    runArchive(['verify', path.resolve(archive), ...(list ? [list] : [])])
  } finally { if (list && fs.existsSync(list)) fs.unlinkSync(list) }
}

function archiveFiles(directory, destination, files, { emptyDirectories = [] } = {}) {
  if (fs.existsSync(destination)) throw new Error('Application archive already exists')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const list = destination + '.files.json'
  fs.writeFileSync(list, JSON.stringify({ files, emptyDirectories }), { flag: 'wx' })
  try {
    runArchive(['create', path.resolve(directory), path.resolve(destination), path.resolve(list)])
    verifyArchive(destination, files, { emptyDirectories })
  } finally { fs.unlinkSync(list) }
  return { path: destination, sha256: u.sha256(destination), size: fs.statSync(destination).size }
}

module.exports = { canonicalJson, validateRelativePath, validateSoftwarePath, fileInventory,
  applicationConfiguration, writeApplicationConfiguration, archiveFiles, verifyArchive }
