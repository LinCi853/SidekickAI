import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { safeBackupPath } from './format.js'
import { DATA_SCHEMA_VERSION, type BackupEdition, type BackupManifest, type CookieSnapshot } from './types.js'

type RecordData = Record<string, any>
export interface TransferDefaults { profile: RecordData; presets: RecordData[] }
const PROFILE_FIELDS = ['id', 'name', 'createdAt', 'updatedAt', 'devicePreset', 'userAgent', 'platform', 'viewport', 'devicePixelRatio', 'language', 'timezone', 'proxy', 'proxyConfig', 'fingerprint', 'width', 'height', 'x', 'y', 'alwaysOnTop', 'order', 'isAIPlatform', 'isBuiltIn', 'aiPlatformUrl', 'browserHomePage', 'aiPlatformId', 'aiPlatformRegion', 'aiDesktopPreset', 'aiMobilePreset', 'uaLockMode', 'aiThemeColor', 'aiInputSelector', 'aiSendSelector', 'popupWhitelist', 'browserWindowShortcut']
const PRESET_FIELDS = ['id', 'name', 'userAgent', 'platform', 'viewport', 'devicePixelRatio', 'navigatorPlatform', 'vendor', 'maxTouchPoints', 'hardwareConcurrency', 'deviceMemory', 'brands', 'chPlatform', 'chPlatformVersion', 'chMobile', 'language', 'timezone', 'builtin']
const PROVIDER_FIELDS = ['id', 'name', 'protocol', 'apiEndpoint', 'apiKeyCipher', 'model', 'alternativeModels', 'temperature', 'maxTokens', 'createdAt', 'updatedAt', 'lastUsedAt', 'ttsEnabled', 'ttsModel', 'sttEnabled', 'sttModel']

function object(value: unknown, label: string): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid backup ${label}.`)
  return value as RecordData
}
function readRow(db: Database.Database, table: string): RecordData {
  if (!db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)) return {}
  const row = db.prepare(`SELECT value FROM ${table} WHERE key='__data__'`).get() as { value: string } | undefined
  return row ? object(JSON.parse(row.value), table) : {}
}
function writeRow(db: Database.Database, table: string, value: RecordData): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  db.prepare(`INSERT INTO ${table} (key,value) VALUES ('__data__',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(value))
}
function array(row: RecordData, key: string): RecordData[] {
  if (row[key] === undefined) return []
  if (!Array.isArray(row[key]) || row[key].length > 1000) throw new Error(`Invalid backup ${key}.`)
  const ids = new Set<string>()
  return row[key].map((value: unknown) => {
    const item = object(value, key)
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate backup ${key} identity.`)
    ids.add(item.id)
    return item
  })
}
function pick(item: RecordData, fields: string[]): RecordData { return Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])) }
function mergeConfiguration(fallback: RecordData, existing: RecordData | undefined, incoming: RecordData): RecordData {
  const result = { ...fallback, ...existing, ...incoming }
  for (const name of ['viewport', 'fingerprint', 'proxyConfig', 'settings']) {
    const sources = [fallback[name], existing?.[name], incoming[name]].filter(value => value !== undefined)
    if (sources.length) result[name] = Object.assign({}, ...sources.map(value => object(value, name)))
  }
  return result
}
function merge(items: RecordData[], next: RecordData): void {
  const index = items.findIndex(item => item.id === next.id)
  if (index < 0) items.push(next)
  else items[index] = next
}
function validateUrl(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`Invalid backup ${label}.`)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Invalid backup ${label}.`)
}
function validateViewport(item: RecordData): void {
  if (!['desktop', 'mobile'].includes(item.platform) || typeof item.userAgent !== 'string' || item.userAgent.length > 4096
    || !item.viewport || ['width', 'height'].some(key => !Number.isFinite(item.viewport[key]) || item.viewport[key] < 1 || item.viewport[key] > 32768)
    || !Number.isFinite(item.devicePixelRatio) || item.devicePixelRatio <= 0 || item.devicePixelRatio > 32) throw new Error('Invalid backup browser configuration.')
}

export function validateSettingsDatabase(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Backup settings database is corrupt.')
    db.prepare('SELECT key,value FROM app_settings LIMIT 0').all()
  } finally { db.close() }
}

function sourceRows(directory: string): Record<string, RecordData> {
  const file = path.join(directory, 'settings.db')
  if (fs.existsSync(file)) {
    validateSettingsDatabase(file)
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try { return Object.fromEntries(['profiles', 'device_presets', 'ai_providers', 'app_key'].map(table => [table, readRow(db, table)])) }
    finally { db.close() }
  }
  const read = (names: string[], fallback: RecordData) => {
    const name = names.find(value => fs.existsSync(path.join(directory, value)))
    return name ? object(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')), name) : fallback
  }
  return { profiles: read(['profiles.json'], { profiles: [] }), device_presets: read(['presets.json', 'device-presets.json'], {}), ai_providers: read(['ai-providers.json'], {}), app_key: read(['app-key.json'], {}) }
}

export function normalizeLegacySettings(directory: string): void {
  const file = path.join(directory, 'settings.db')
  if (fs.existsSync(file)) return
  const rows = sourceRows(directory)
  const db = new Database(file)
  try {
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE module_state (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,installed INTEGER NOT NULL DEFAULT 1,cleared_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0); CREATE TABLE settings_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    for (const [table, value] of Object.entries(rows)) if (Object.keys(value).length) writeRow(db, table, { version: 1, ...value })
  } finally { db.close() }
}

function decodeSecret(cipher: string, key: unknown): string {
  if (!cipher) return ''
  if (cipher.startsWith('plain:')) return cipher.slice(6)
  if (cipher.startsWith('xor:')) {
    const data = Buffer.from(cipher.slice(4), 'base64')
    const xorKey = Buffer.from('ai-window-xor-fallback-v1')
    return Buffer.from(data.map((byte, index) => byte ^ xorKey[index % xorKey.length])).toString('utf8')
  }
  if (!cipher.startsWith('aes:')) throw new Error('此备份的 API 密钥绑定原系统，请在来源应用重新保存密钥并导出。')
  const bytes = Buffer.from(cipher.slice(4), 'base64')
  const sourceKey = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.alloc(0)
  if (sourceKey.length !== 32 || bytes.length < 28) throw new Error('备份的 API 密钥或加密凭据无效。')
  const decipher = createDecipheriv('aes-256-gcm', sourceKey, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')
}
function encodeSecret(plain: string, key: Buffer): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return 'aes:' + Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64')
}

/** Validate transfer inputs without opening or migrating the destination database. */
export function validateTransfer(directory: string, defaults: TransferDefaults): void {
  const rows = sourceRows(directory)
  for (const preset of array(rows.device_presets, 'presets')) validateViewport(mergeConfiguration(defaults.presets.find(item => item.id === preset.id) ?? defaults.presets[0], undefined, preset))
  for (const profile of array(rows.profiles, 'profiles').filter(item => item.isAIPlatform)) {
    if (profile.isAIPlatform !== true || profile.isBuiltIn !== undefined && typeof profile.isBuiltIn !== 'boolean'
      || typeof profile.name !== 'string' || profile.name.length > 256
      || ['devicePreset', 'aiDesktopPreset', 'aiMobilePreset', 'aiPlatformId'].some(key => profile[key] !== undefined && typeof profile[key] !== 'string')) throw new Error('Invalid backup AI application.')
    validateViewport(mergeConfiguration(defaults.profile, undefined, profile))
    if (profile.aiPlatformUrl !== undefined) validateUrl(profile.aiPlatformUrl, 'AI application URL')
  }
  for (const provider of array(rows.ai_providers, 'providers')) {
    validateUrl(provider.apiEndpoint, 'API endpoint')
    if (typeof provider.name !== 'string' || typeof provider.model !== 'string' || !['openai', 'anthropic', 'custom'].includes(provider.protocol)
      || provider.apiKeyCipher !== undefined && typeof provider.apiKeyCipher !== 'string') throw new Error('Invalid backup API configuration.')
    decodeSecret(provider.apiKeyCipher ?? '', rows.app_key.key)
  }
}

function assertRealTree(directory: string): void {
  const root = fs.lstatSync(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Application data must be a real directory.')
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Application data contains a filesystem link.')
    if (entry.isDirectory()) assertRealTree(path.join(directory, entry.name))
    else if (!entry.isFile()) throw new Error('Application data contains a special file.')
  }
}

function replaceIncludedStorage(source: string, target: string): void {
  if (!fs.existsSync(source)) return
  const info = fs.lstatSync(source)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid backup storage directory.')
  assertRealTree(source)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true, dereference: false })
}

/** Preserve roots absent from a compatible archive for editions with an included-entry restore contract. */
export function composeIncludedRestore(root: string, staged: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')) as BackupManifest
  const replaced = new Set(fs.readdirSync(staged))
  for (const name of replaced) if (name.endsWith('.db')) for (const suffix of ['-wal', '-shm', '-journal']) replaced.add(name + suffix)
  if (manifest.options.cookies && manifest.cookieSnapshots) {
    for (const name of ['Cookies', 'Network', 'Local State']) replaced.add(name)
    if (manifest.cookieSnapshots.some(snapshot => snapshot.path)) replaced.add('Partitions')
  }
  assertRealTree(root)
  for (const name of fs.readdirSync(root)) if (!replaced.has(name)) fs.cpSync(path.join(root, name), path.join(staged, name), { recursive: true, dereference: false })
}

/** Compose a destination snapshot during cold startup; the live root remains untouched until the atomic replacement. */
export function composeLimitedRestore(root: string, staged: string, edition: BackupEdition, defaults: TransferDefaults): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')) as BackupManifest
  validateTransfer(staged, defaults)
  const source = sourceRows(staged)
  const composed = fs.mkdtempSync(`${staged}.compose-`)
  try {
    assertRealTree(root)
    fs.cpSync(root, composed, { recursive: true, dereference: false })
    const settings = path.join(composed, 'settings.db')
    const db = new Database(settings)
    const profileIds = new Map<string, string>()
    try {
      db.pragma('journal_mode = DELETE')
      db.transaction(() => {
        const presetRow = readRow(db, 'device_presets')
        const presets = array(presetRow, 'presets')
        for (const incoming of array(source.device_presets, 'presets')) {
          const existing = presets.find(item => item.id === incoming.id)
          const fallback = defaults.presets.find(item => item.id === incoming.id) ?? defaults.presets[0]
          const fields = edition === 'community' ? [...PRESET_FIELDS, 'architecture', 'settings'] : PRESET_FIELDS
          merge(presets, mergeConfiguration(fallback, existing, pick(incoming, fields)))
        }
        const profileRow = readRow(db, 'profiles')
        const profiles = array(profileRow, 'profiles')
        for (const incoming of array(source.profiles, 'profiles').filter(item => item.isAIPlatform)) {
          let existing = profiles.find(item => item.id === incoming.id && item.isAIPlatform)
          if (!existing && incoming.isBuiltIn && incoming.aiPlatformId) existing = profiles.find(item => item.isBuiltIn && item.aiPlatformId === incoming.aiPlatformId)
          const id = existing?.id ?? (profiles.some(item => item.id === incoming.id) ? randomUUID() : incoming.id)
          profileIds.set(incoming.id, id)
          const fields = edition === 'community' ? [...PROFILE_FIELDS, 'catalogDefinition'] : PROFILE_FIELDS
          const result = mergeConfiguration(defaults.profile, existing, pick(incoming, fields))
          Object.assign(result, { id, createdAt: existing?.createdAt ?? incoming.createdAt ?? Date.now(), updatedAt: incoming.updatedAt ?? Date.now(), isBuiltIn: existing?.isBuiltIn ?? incoming.isBuiltIn ?? false })
          for (const key of ['devicePreset', 'aiDesktopPreset', 'aiMobilePreset']) {
            if (!result[key] || result[key] === 'custom') continue
            if (!presets.some(item => item.id === result[key])) {
              const fallback = defaults.presets.find(item => item.id === result[key]) ?? defaults.presets.find(item => item.platform === (key === 'aiMobilePreset' ? 'mobile' : key === 'aiDesktopPreset' ? 'desktop' : result.platform))
              if (!fallback) throw new Error('Backup application has no supported device preset.')
              if (!presets.some(item => item.id === fallback.id)) presets.push(fallback)
              result[key] = fallback.id
            }
          }
          validateViewport(result)
          merge(profiles, result)
        }
        if (source.device_presets.presets !== undefined || source.profiles.profiles !== undefined) writeRow(db, 'device_presets', { ...presetRow, version: presetRow.version ?? 1, presets })
        if (source.profiles.profiles !== undefined) writeRow(db, 'profiles', { ...profileRow, version: profileRow.version ?? 1, profiles })
        const providerRow = readRow(db, 'ai_providers')
        const providers = array(providerRow, 'providers')
        const incomingProviders = array(source.ai_providers, 'providers')
        if (incomingProviders.length) {
          const appKey = readRow(db, 'app_key')
          const key = appKey.key ? Buffer.from(appKey.key, 'base64') : randomBytes(32)
          if (key.length !== 32) throw new Error('当前应用密钥无效，未导入任何数据。')
          if (!appKey.key) writeRow(db, 'app_key', { ...appKey, version: 1, key: key.toString('base64'), createdAt: Date.now() })
          for (const incoming of incomingProviders) {
            const existing = providers.find(item => item.id === incoming.id)
            const plain = decodeSecret(incoming.apiKeyCipher ?? '', source.app_key.key)
            merge(providers, { ...existing, ...pick(incoming, PROVIDER_FIELDS), apiKeyCipher: plain ? encodeSecret(plain, key) : existing?.apiKeyCipher ?? '', createdAt: existing?.createdAt ?? incoming.createdAt ?? Date.now(), updatedAt: incoming.updatedAt ?? Date.now(), lastUsedAt: existing?.lastUsedAt ?? null })
          }
          writeRow(db, 'ai_providers', { ...providerRow, version: providerRow.version ?? 1, providers })
        }
      })()
    } finally { db.close() }

    const snapshots: CookieSnapshot[] = []
    for (const [sourceId, targetId] of profileIds) {
      for (const suffix of ['', '-browser']) {
        const inputPath = `Partitions/${sourceId.toLowerCase()}${suffix}`
        const outputPath = `Partitions/${targetId.toLowerCase()}${suffix}`
        if (!safeBackupPath(inputPath) || !safeBackupPath(outputPath)) throw new Error('Invalid mapped session path.')
        const sourcePartition = path.join(staged, inputPath)
        const targetPartition = path.join(composed, outputPath)
        if (manifest.options.cookies) replaceIncludedStorage(path.join(sourcePartition, 'Local Storage'), path.join(targetPartition, 'Local Storage'))
        if (manifest.options.indexedDB) for (const name of ['IndexedDB', 'File System', 'blob_storage', 'WebStorage']) replaceIncludedStorage(path.join(sourcePartition, name), path.join(targetPartition, name))
        const snapshot = manifest.cookieSnapshots?.find(item => item.path.toLowerCase() === inputPath.toLowerCase())
        if (snapshot) {
          for (const name of ['Cookies', 'Network/Cookies']) for (const sidecar of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(targetPartition, name + sidecar), { force: true })
          snapshots.push({ path: outputPath, cookies: snapshot.cookies })
        }
      }
    }
    const restored = { ...manifest, legacy: undefined, edition, dataSchemaVersion: DATA_SCHEMA_VERSION, restoreMode: 'limited', cookieSnapshots: snapshots, entries: { 'settings.db': createHash('sha256').update(fs.readFileSync(settings)).digest('hex') } }
    fs.writeFileSync(path.join(composed, 'manifest.json'), JSON.stringify(restored))
    const sourceDirectory = `${staged}.source`
    fs.renameSync(staged, sourceDirectory)
    try { fs.renameSync(composed, staged) }
    catch (error) { fs.renameSync(sourceDirectory, staged); throw error }
    fs.rmSync(sourceDirectory, { recursive: true, force: true })
  } finally { if (fs.existsSync(composed)) fs.rmSync(composed, { recursive: true, force: true }) }
}
