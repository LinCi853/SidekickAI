import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { captureBackupSessions, captureOfflineCookies } from './sessions.js'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from './format.js'
import { DATA_SCHEMA_VERSION, type BackupEdition, type BackupOptions } from './types.js'

export interface SelectedFile { category: 'basicData' | 'cookies' | 'indexedDB' | 'cache' | 'plugins'; sourcePath: string; archivePath: string }
export interface ExportResult {
  success: boolean; error?: string; filePath?: string; sourceRoot?: string; sourceEntries?: Record<string, string>; skippedFiles?: string[]
  options?: BackupOptions; strict?: boolean; categories?: string[]; treeSha256?: string
}
export interface ExportHooks {
  afterInventory?: (root: string, paths: string[]) => void | Promise<void>
  afterExport?: (root: string) => void | Promise<void>
  beforePublish?: (target: string) => void | Promise<void>
}
export interface ExportAdapter {
  edition: BackupEdition
  root(): string
  version(): string
  deviceId(): string
  closeDatabases(strict: boolean): Promise<void>
  collect(root: string, options: BackupOptions, strict: boolean): Promise<SelectedFile[]>
  validate(root: string): void
  verifyPayload(zip: AdmZip): void
  treeDigest(root: string): string
  verifySources(before: Record<string, string>, entries: SelectedFile[], after: SelectedFile[]): void
  writeStrict(target: string, zip: AdmZip, encrypt: { password: string } | undefined, deviceId: string, reverify: () => Promise<void>): Promise<void>
  writeLive(target: string, zip: AdmZip, encrypt: { password: string } | undefined, deviceId: string): void
  hooks?: ExportHooks
}

function selected(entries: SelectedFile[], portable: boolean, strict: boolean): SelectedFile[] {
  return entries.filter(entry => {
    if (!strict && entry.category !== 'basicData' && entry.category !== 'plugins' && ['LOCK', 'LOG', 'LOG.old'].includes(path.posix.basename(entry.archivePath))) return false
    return strict || !portable || entry.category !== 'cookies' || entry.archivePath !== 'Local State' && !/(^|\/)(?:Network\/)?Cookies(?:-wal|-shm|-journal)?$/.test(entry.archivePath)
  })
}

async function readFile(file: SelectedFile): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return fs.readFileSync(file.sourcePath) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < 2 && ['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) { await new Promise(resolve => setTimeout(resolve, 300)); continue }
      throw new Error(`Selected source file is missing or unreadable: ${file.archivePath} (${code ?? String(error)})`)
    }
  }
  throw new Error(`Selected source file could not be read: ${file.archivePath}`)
}

export async function exportBackup(adapter: ExportAdapter, targetPath: string, options: BackupOptions, encrypt?: { password: string }, strictOptions?: { strict?: boolean; expectedDataRoot?: string }): Promise<ExportResult> {
  const strict = strictOptions?.strict === true
  try {
    const root = adapter.root()
    if (strict) {
      const expected = strictOptions?.expectedDataRoot
      const equal = expected && (process.platform === 'win32' ? path.resolve(expected).toLowerCase() === path.resolve(root).toLowerCase() : path.resolve(expected) === path.resolve(root))
      if (!equal) throw new Error('Strict export requires the exact expected application data root.')
      if (fs.existsSync(targetPath)) throw new Error('Backup destination already exists.')
    }
    if (!options.basicData) throw new Error('Application backups require basic data.')
    adapter.validate(root)
    const deviceId = strict ? `${adapter.edition}-maintenance` : adapter.deviceId()
    let snapshots = strict ? undefined : await captureBackupSessions(root, options)
    await adapter.closeDatabases(true)
    const treeSha256 = strict ? adapter.treeDigest(root) : undefined
    const entries = selected(await adapter.collect(root, options, true), snapshots !== undefined, strict)
    await adapter.hooks?.afterInventory?.(root, entries.map(entry => entry.archivePath))
    const staged: Array<{ entry: SelectedFile; data: Buffer }> = []
    const sourceEntries: Record<string, string> = {}
    for (const entry of entries) {
      const data = await readFile(entry)
      staged.push({ entry, data })
      sourceEntries[entry.archivePath] = createHash('sha256').update(data).digest('hex')
    }
    if (!sourceEntries['settings.db']) throw new Error('Export failed: the archive is missing settings.db.')
    if (strict && options.cookies) snapshots = await captureOfflineCookies(staged.map(({ entry, data }) => ({ archivePath: entry.archivePath, data })))
    const zip = new AdmZip()
    for (const { entry, data } of staged) zip.addFile(entry.archivePath, data)
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, edition: adapter.edition, dataSchemaVersion: DATA_SCHEMA_VERSION,
      deviceId, appVersion: adapter.version(), exportedAt: new Date().toISOString(), options, entries: sourceEntries, cookieSnapshots: snapshots,
    }, null, 2)))
    adapter.verifyPayload(zip)
    const reverify = async () => {
      const after = selected(await adapter.collect(root, options, true), snapshots !== undefined, strict)
      adapter.verifySources(sourceEntries, entries, after)
      if (strict && adapter.treeDigest(root) !== treeSha256) throw new Error('Selected source data changed during export (complete data tree digest mismatch).')
    }
    if (strict) {
      await adapter.hooks?.afterExport?.(root)
      await adapter.writeStrict(targetPath, zip, encrypt, deviceId, async () => { await adapter.hooks?.beforePublish?.(targetPath); await reverify() })
    } else { await reverify(); adapter.writeLive(targetPath, zip, encrypt, deviceId) }
    return { success: true, filePath: targetPath, sourceRoot: root, sourceEntries, skippedFiles: [], options, strict, categories: ['basicData', 'cookies', 'indexedDB', 'cache'].filter(key => options[key as keyof BackupOptions]), treeSha256 }
  } catch (error) { return { success: false, error: (error as Error).message, options, strict, skippedFiles: [] } }
}
