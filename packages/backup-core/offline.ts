import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { exportBackup, type ExportPreparation, type ExportResult, type SelectedFile } from './export.js'
import { exportTreeDigest, sha256FileSync } from './files.js'
import { assertOrdinaryPath } from './io.js'
import type { BackupEdition, BackupOptions } from './types.js'

export interface OfflineBackupRequest extends ExportPreparation {
  sourceRoot: string
  edition: BackupEdition
  version: string
  targetPath: string
  options: BackupOptions
  password?: string
}

function category(relative: string): SelectedFile['category'] {
  if (relative.startsWith('plugins/')) return 'plugins'
  const storage = relative.replace(/^Partitions\/[^/]+\//, '')
  if (relative === 'Local State' || /^(?:Network\/)?Cookies(?:$|-)/.test(storage) || storage.startsWith('Local Storage/')) return 'cookies'
  if (/^(?:IndexedDB|File System|blob_storage|WebStorage)\//.test(storage)) return 'indexedDB'
  if (/^(?:Service Worker|Cache|Code Cache|GPUCache)\//.test(storage)) return 'cache'
  return 'basicData'
}

/** Unknown ordinary files are retained; only user-excluded storage categories are omitted. */
export function collectOfflineFiles(root: string, options: BackupOptions): SelectedFile[] {
  assertOrdinaryPath(root, true)
  const entries: SelectedFile[] = []
  const walk = (directory: string, prefix: string) => {
    for (const name of fs.readdirSync(directory)) {
      const sourcePath = path.join(directory, name)
      const archivePath = prefix ? `${prefix}/${name}` : name
      const info = fs.lstatSync(sourcePath)
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error(`Offline backup contains a link or special file: ${archivePath}`)
      if (info.isDirectory()) walk(sourcePath, archivePath)
      else {
        const group = category(archivePath)
        if (group === 'plugins' || options[group]) entries.push({ category: group, sourcePath, archivePath })
      }
    }
  }
  walk(root, '')
  return entries
}

export function verifyOfflineSources(before: Record<string, string>, entries: SelectedFile[], after: SelectedFile[]): void {
  const names = new Set(entries.map(entry => entry.archivePath))
  if (after.length !== entries.length || after.some(entry => !names.has(entry.archivePath))) throw new Error('Selected source data changed during export (inventory mismatch).')
  for (const entry of after) if (sha256FileSync(entry.sourcePath) !== before[entry.archivePath]) throw new Error(`Selected source file changed during export: ${entry.archivePath}`)
}

async function validateOfflineSnapshot(root: string): Promise<void> {
  const moduleName = 'node:sqlite'
  const { DatabaseSync } = await import(moduleName)
  const scratch = fs.mkdtempSync(path.join(path.dirname(root), '.sqlite-check-'))
  try {
    for (const name of fs.readdirSync(root)) if (/\.db(?:-wal|-shm|-journal)?$/.test(name)) fs.copyFileSync(path.join(root, name), path.join(scratch, name), fs.constants.COPYFILE_EXCL)
    for (const name of fs.readdirSync(scratch)) {
      if (!name.endsWith('.db')) continue
      const database = new DatabaseSync(path.join(scratch, name), { readOnly: true })
      try {
        const rows = database.prepare('PRAGMA quick_check').all()
        if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw new Error(`Backup database is corrupt: ${name}`)
        if (name === 'settings.db') { database.prepare('SELECT key,value FROM app_settings LIMIT 0').all(); database.prepare('SELECT id FROM module_state LIMIT 0').all() }
      } finally { database.close() }
    }
    validateOfflinePlugins(path.join(root, 'plugins'))
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new Error('Unsupported plugin registry value.')
}

function validateOfflinePlugins(directory: string): void {
  const registry = path.join(directory, '.registry-v2.json')
  if (!fs.existsSync(registry)) return
  if (assertOrdinaryPath(registry).size > 8 * 1024 * 1024) throw new Error('Plugin registry exceeds the backup limit.')
  const value = JSON.parse(fs.readFileSync(registry, 'utf8'))
  if (!value || value.version !== 2 || !Array.isArray(value.records) || value.records.length > 1000) throw new Error('Invalid plugin backup registry.')
  const identifiers = new Set<string>()
  for (const record of value.records) {
    if (!record || typeof record.pluginId !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(record.pluginId) || identifiers.has(record.pluginId)
      || typeof record.dataVersion !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.dataVersion)
      || typeof record.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.contentHash)) throw new Error('Invalid plugin backup identity.')
    identifiers.add(record.pluginId)
    const installed = path.join(directory, record.pluginId)
    const files = collectOfflineFiles(installed, { basicData: true, cookies: true, indexedDB: true, cache: true }).map(entry => ({ path: entry.archivePath, size: fs.statSync(entry.sourcePath).size, sha256: sha256FileSync(entry.sourcePath) })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    if (createHash('sha256').update(canonicalJson(files)).digest('hex') !== record.contentHash) throw new Error(`Plugin package bytes differ from their registry: ${record.pluginId}`)
    const manifestFile = path.join(installed, 'manifest.json')
    if (assertOrdinaryPath(manifestFile).size > 256 * 1024) throw new Error('Plugin manifest exceeds its supported size.')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    if (manifest.id !== record.pluginId || manifest.version !== record.version) throw new Error('Plugin manifest identity differs from its registry.')
    assertOrdinaryPath(path.join(directory, '.data', record.pluginId, record.dataVersion), true)
  }
}

/** This runtime never opens Chromium or relies on the original installation. Raw cookies remain profile-bound. */
export async function exportOfflineBackup(request: OfflineBackupRequest): Promise<ExportResult> {
  const root = path.resolve(request.sourceRoot)
  return exportBackup({
    edition: request.edition, root: () => root, version: () => request.version, deviceId: () => `${request.edition}-offline`,
    closeDatabases: async () => {}, collect: collectOfflineFiles, validate: source => { assertOrdinaryPath(source, true) },
    validateSnapshot: validateOfflineSnapshot, treeDigest: exportTreeDigest, verifySources: verifyOfflineSources, cookieTransfer: 'raw-profile',
  }, request.targetPath, request.options, request.password ? { password: request.password } : undefined,
  { ...request, strict: request.strict ?? true, snapshot: true, expectedDataRoot: root })
}
