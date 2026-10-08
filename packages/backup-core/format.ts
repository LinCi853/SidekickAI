import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import type { BackupManifest, CookieSnapshot } from './types.js'
import { MAX_BACKUP_ENTRIES, MAX_BACKUP_BYTES } from './io.js'
import { validateSensitiveDrafts } from './sensitive-drafts-format.js'
export type { BackupManifest, CookieSnapshot } from './types.js'

export const BACKUP_FORMAT = 'sidekickai-backup'
export const BACKUP_FORMAT_VERSION = 1

export function safeBackupPath(value: string): boolean {
  return !!value && !value.includes('\\') && !/[\x00-\x1f\x7f<>:"|?*]/.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..'
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

export function normalizeEdition(value: unknown): BackupManifest['edition'] {
  if (value === 'concept' || value === 'sidekickai-opensource') return 'concept'
  if (value === 'community' || value === 'sidekick-ai') return 'community'
  return undefined
}

export function cookieSetDetails(cookie: Electron.Cookie): Electron.CookiesSetDetails {
  if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
    || typeof cookie.domain !== 'string' || !cookie.domain || /[\s/@\\:]/.test(cookie.domain)
    || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')
    || !['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)
    || ['hostOnly', 'httpOnly', 'secure', 'session'].some(key => typeof cookie[key as keyof Electron.Cookie] !== 'boolean')
    || cookie.expirationDate !== undefined && !Number.isFinite(cookie.expirationDate)) throw new Error('Invalid backup cookie.')
  return {
    // A trusted replay origin permits overlapping cookies while retaining their individual Secure attributes.
    url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
    name: cookie.name, value: cookie.value, path: cookie.path,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    ...(!cookie.session && cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
  }
}

export function validateSnapshots(manifest: BackupManifest): void {
  if (manifest.cookieSnapshots === undefined) return
  if (!manifest.options.cookies || !Array.isArray(manifest.cookieSnapshots)) throw new Error('Invalid backup cookie snapshots.')
  const seen = new Set<string>()
  for (const snapshot of manifest.cookieSnapshots) {
    if (!snapshot || typeof snapshot.path !== 'string' || seen.has(snapshot.path.toLowerCase())
      || snapshot.path !== '' && (!/^Partitions\/[^/]+$/.test(snapshot.path) || !safeBackupPath(snapshot.path))
      || !Array.isArray(snapshot.cookies)) throw new Error('Invalid backup session path.')
    seen.add(snapshot.path.toLowerCase())
    for (const cookie of snapshot.cookies) cookieSetDetails(cookie)
  }
}

export function parseBackupManifest(raw: unknown): BackupManifest {
  const manifest = raw as BackupManifest | undefined
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error('Unsupported backup format. Export a new backup using the current application.')
  if (typeof manifest.deviceId !== 'string' || !manifest.deviceId || typeof manifest.appVersion !== 'string'
    || typeof manifest.exportedAt !== 'string' || !manifest.options || manifest.options.basicData !== true
    || ['cookies', 'indexedDB', 'cache'].some(key => typeof manifest.options[key as keyof BackupManifest['options']] !== 'boolean')
    || !manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries)
    || !Object.hasOwn(manifest.entries, 'settings.db')) throw new Error('Invalid backup manifest or missing settings.db.')
  if (manifest.edition !== undefined && !normalizeEdition(manifest.edition)
    || manifest.dataSchemaVersion !== undefined && (!Number.isSafeInteger(manifest.dataSchemaVersion) || manifest.dataSchemaVersion < 1)) throw new Error('Invalid backup data identity.')
  for (const [name, hash] of Object.entries(manifest.entries)) {
    if (!safeBackupPath(name) || name === 'manifest.json' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid backup inventory entry: ${name}`)
  }
  if (Object.keys(manifest.entries).length + 1 > MAX_BACKUP_ENTRIES) throw new Error('Backup manifest contains too many entries.')
  if (manifest.inventory !== undefined) {
    if (!Array.isArray(manifest.inventory) || manifest.inventory.length !== Object.keys(manifest.entries).length) throw new Error('Invalid snapshot inventory.')
    const paths = new Set<string>()
    let total = 0
    for (const entry of manifest.inventory) {
      total += entry.size
      if (paths.has(entry.path) || !Object.hasOwn(manifest.entries, entry.path) || manifest.entries[entry.path] !== entry.sha256 || entry.state !== 'verified'
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(total)) throw new Error('Invalid snapshot inventory entry.')
      paths.add(entry.path)
    }
  }
  validateSnapshots(manifest)
  if (manifest.sensitiveDrafts !== undefined) validateSensitiveDrafts(manifest.sensitiveDrafts)
  return { ...manifest, edition: normalizeEdition(manifest.edition) }
}

function validatePaths(zip: AdmZip): void {
  const entries = zip.getEntries()
  if (entries.length > MAX_BACKUP_ENTRIES) throw new Error('Backup contains too many entries.')
  const seen = new Set<string>()
  const files = new Set<string>()
  let total = 0
  for (const entry of entries) {
    const name = entry.entryName.replace(/\/$/, '')
    const key = name.toLowerCase()
    const mode = (entry.attr >>> 16) & 0xf000
    total += entry.header.size
    if (!safeBackupPath(name) || seen.has(key) || mode && mode !== (entry.isDirectory ? 0x4000 : 0x8000)
      || !Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || !Number.isSafeInteger(total) || total > MAX_BACKUP_BYTES) throw new Error(`Invalid backup entry: ${entry.entryName}`)
    seen.add(key)
    if (!entry.isDirectory) files.add(key)
  }
  for (const name of seen) {
    const segments = name.split('/')
    for (let index = 1; index < segments.length; index++) if (files.has(segments.slice(0, index).join('/'))) throw new Error(`Conflicting backup entry: ${name}`)
  }
}

export function validateBackupArchive(zip: AdmZip): BackupManifest {
  validatePaths(zip)
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry || manifestEntry.isDirectory) throw new Error('Unsupported backup format. Export a new backup using the current application.')
  const manifest = parseBackupManifest(JSON.parse(manifestEntry.getData().toString('utf8')))
  const expected = new Set(Object.keys(manifest.entries))
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.entryName === 'manifest.json') continue
    const hash = createHash('sha256').update(entry.getData()).digest('hex')
    if (!expected.delete(entry.entryName) || hash !== manifest.entries[entry.entryName]) throw new Error(`Backup integrity check failed: ${entry.entryName}`)
  }
  if (expected.size) throw new Error(`Backup is missing files: ${[...expected].join(', ')}`)
  return manifest
}

/** Historical archives have no trusted inventory; their supported database shape is checked after extraction. */
export function readBackupArchive(zip: AdmZip): BackupManifest {
  validatePaths(zip)
  const raw = zip.getEntry('manifest.json') ? JSON.parse(zip.readAsText('manifest.json')) : {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid backup manifest.')
  if (raw.format !== undefined || raw.formatVersion !== undefined) return validateBackupArchive(zip)
  if (!zip.getEntry('settings.db') && !zip.getEntry('profiles.json')) throw new Error('Backup is missing application settings.')
  if (raw.appVersion !== undefined && typeof raw.appVersion !== 'string') throw new Error('Invalid historical backup version.')
  let identity: Record<string, unknown> = {}
  if (zip.getEntry('edition-identity.json')) {
    identity = JSON.parse(zip.readAsText('edition-identity.json'))
    if (!identity || identity.schema !== 1 || !normalizeEdition(identity.edition)) throw new Error('Invalid historical backup ownership.')
  }
  const declared = normalizeEdition(raw.edition)
  const owned = normalizeEdition(identity.edition)
  if (raw.edition !== undefined && !declared || declared && owned && declared !== owned) throw new Error('Conflicting historical backup ownership.')
  const entries: Record<string, string> = {}
  for (const entry of zip.getEntries()) if (!entry.isDirectory && entry.entryName !== 'manifest.json') entries[entry.entryName] = createHash('sha256').update(entry.getData()).digest('hex')
  const names = Object.keys(entries)
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, legacy: true,
    edition: declared ?? owned, deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : 'legacy',
    appVersion: raw.appVersion ?? 'legacy', exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', entries,
    options: { basicData: true, cookies: names.some(name => /(^|\/)(Local Storage\/|(?:Network\/)?Cookies(?:$|-))/.test(name)), indexedDB: names.some(name => /(^|\/)IndexedDB\//.test(name)), cache: names.some(name => /(^|\/)(?:Cache|GPUCache|Code Cache)\//.test(name)) },
    cookieSnapshots: raw.cookieSnapshots,
  }
  if (manifest.cookieSnapshots) manifest.options.cookies = true
  validateSnapshots(manifest)
  return manifest
}

export function extractBackupArchive(zip: AdmZip, directory: string): BackupManifest {
  const manifest = readBackupArchive(zip)
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\/$/, '')
    const target = path.join(directory, name)
    if (entry.isDirectory) fs.mkdirSync(target, { recursive: true })
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, entry.getData(), { flag: 'wx' }) }
  }
  return manifest
}
