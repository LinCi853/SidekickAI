import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type AdmZip from 'adm-zip'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, parseBackupManifest } from './format.js'
import { SABK_MAX_PLAINTEXT_BYTES } from './file-crypto.js'
import { validateArchiveSelection, type ArchiveEntry } from './stream-archive.js'
import { assertOrdinaryPath, atomicJson, checkAbort, checkDiskSpace, copyFileVerified, diskIdentity, hashFile, identityMatches, isWithin, MAX_MANIFEST_BYTES, retryIo, samePath, type DiskIdentity } from './io.js'
import { backupCancellationRequested, backupJobDirectory, backupJobResult, backupManifestPath, backupSnapshotDirectory, createBackupJob, discardTemporaryBackupJob, failBackupJob, finishBackupJob, lockBackupJob, prepareBackupTarget, queryBackupJob, saveBackupJob, type BackupJob, type BackupJobControl, type BackupJobResult } from './jobs.js'
import { DATA_SCHEMA_VERSION, type BackupEdition, type BackupManifest, type BackupOptions, type CookieSnapshot, type SensitiveDraftTransport } from './types.js'

export interface SelectedFile { category: 'basicData' | 'cookies' | 'indexedDB' | 'cache' | 'plugins'; sourcePath: string; archivePath: string }
export interface ExportResult extends Partial<BackupJobResult> {
  success: boolean
  error?: string
  retryable?: boolean
}
class SnapshotUnavailableError extends Error { }

async function sourceOperation<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    const reason = error as NodeJS.ErrnoException
    if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(reason.code ?? '')
      || /Selected source (?:file|data).*changed during export|Selected source file disappeared during export|Selected (?:source file|backup entry).*\((?:ENOENT|EBUSY|EPERM|EACCES)\)/i.test(reason.message)) throw new SnapshotUnavailableError(reason.message)
    throw error
  }
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
  validate(root: string): void | Promise<void>
  validateSnapshot?(root: string): void | Promise<void>
  treeDigest(root: string): string
  verifySources(before: Record<string, string>, entries: SelectedFile[], after: SelectedFile[]): void | Promise<void>
  cookieTransfer?: 'portable-snapshot' | 'raw-profile'
  hooks?: ExportHooks
  verifyPayload?(zip: AdmZip): void
  writeStrict?(target: string, zip: AdmZip, encrypt: { password: string } | undefined, deviceId: string, reverify: () => Promise<void>): Promise<void>
  writeLive?(target: string, zip: AdmZip, encrypt: { password: string } | undefined, deviceId: string): void
}
export interface ExportPreparation extends BackupJobControl {
  strict?: boolean
  snapshot?: boolean
  expectedDataRoot?: string
  onSnapshotReady?: () => Promise<void>
  jobId?: string
  cleanup?: boolean
}

export async function retrySourceSnapshot(perform: () => Promise<ExportResult>): Promise<ExportResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await perform()
    if (result.success || !result.retryable || attempt >= 2) return result
    await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)))
  }
}

function selected(entries: SelectedFile[], portable: boolean, offline: boolean): SelectedFile[] {
  return entries.filter(entry => {
    if (!offline && entry.category !== 'basicData' && entry.category !== 'plugins' && ['LOCK', 'LOG', 'LOG.old'].includes(path.posix.basename(entry.archivePath))) return false
    return offline || !portable || entry.category !== 'cookies' || entry.archivePath !== 'Local State' && !/(^|\/)(?:Network\/)?Cookies(?:-wal|-shm|-journal)?$/.test(entry.archivePath)
  })
}

function appendEntryState(job: BackupJob, entry: Record<string, unknown>, control: BackupJobControl): void {
  const descriptor = fs.openSync(path.join(backupJobDirectory(job.id, control.tempRoot), 'entries.jsonl'), 'a', 0o600)
  try { fs.writeSync(descriptor, JSON.stringify({ snapshotId: job.snapshotId, ...entry }) + '\n'); fs.fsyncSync(descriptor) }
  finally { fs.closeSync(descriptor) }
}

/** A verified disk snapshot is the sole input to compression, encryption and resumable publication. */
export async function exportBackup(adapter: ExportAdapter, targetPath: string, options: BackupOptions, encrypt?: { password: string }, preparation: ExportPreparation = {}): Promise<ExportResult> {
  const strict = preparation.strict === true
  const offline = strict || preparation.snapshot === true
  const control: BackupJobControl = { tempRoot: preparation.tempRoot, password: encrypt?.password, signal: preparation.signal, onProgress: preparation.onProgress }
  let job: BackupJob | undefined
  let unlock: (() => void) | undefined
  let temporaryIdentity: DiskIdentity | undefined
  try {
    const root = path.resolve(adapter.root())
    assertOrdinaryPath(root, true)
    if (offline && (!preparation.expectedDataRoot || !samePath(preparation.expectedDataRoot, root))) throw new Error('Strict export requires the exact expected application data root.')
    if (!options.basicData) throw new Error('Application backups require basic data.')
    job = preparation.jobId && fs.existsSync(backupJobDirectory(preparation.jobId, control.tempRoot)) ? queryBackupJob(preparation.jobId, control.tempRoot) : createBackupJob({
      jobId: preparation.jobId, sourceRoot: root, sourceIdentity: diskIdentity(root), targetPath: path.resolve(targetPath), edition: adapter.edition, appVersion: adapter.version(),
      deviceId: strict ? `${adapter.edition}-maintenance` : adapter.deviceId(), options, encrypted: !!encrypt, strict,
    }, control)
    if (!samePath(job.sourceRoot, root) || job.edition !== adapter.edition || JSON.stringify(job.options) !== JSON.stringify(options) || job.strict !== strict || job.encrypted !== !!encrypt) throw new Error('Backup job does not match the requested source, edition or selection.')
    unlock = lockBackupJob(job, control.tempRoot)
    if (preparation.cleanup && !strict && !preparation.jobId) temporaryIdentity = diskIdentity(backupJobDirectory(job.id, control.tempRoot))
    fs.rmSync(path.join(backupJobDirectory(job.id, control.tempRoot), 'cancel'), { force: true })
    await prepareBackupTarget(job, { ...control, targetPath })
    if (job.snapshotReady) {
      if (!strict) await preparation.onSnapshotReady?.()
      return await finishBackupJob(job, { ...control, targetPath }, strict ? async () => adapter.hooks?.beforePublish?.(targetPath) : undefined)
    }
    if (!identityMatches(diskIdentity(root), job.sourceIdentity)) throw new Error('Backup source identity changed before capture.')
    job.status = 'running'; job.error = undefined; job.waitingReason = undefined
    job.artifactSha256 = undefined; job.artifactBytes = undefined; job.archiveSha256 = undefined
    if (job.transfer) Object.assign(job.transfer, { checkpointId: randomUUID(), checkpointBytes: 0, completedBytes: 0, blockCount: 0 })
    job.snapshotId = randomUUID()
    const snapshot = backupSnapshotDirectory(job, control.tempRoot)
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 })
    await adapter.validate(root)
    let cookies: CookieSnapshot[] | undefined
    let sensitiveDrafts: SensitiveDraftTransport | undefined
    if (!offline && (options.cookies || options.indexedDB || options.cache)) cookies = await (await import('./sessions.js')).captureBackupSessions(root, options)
    await adapter.closeDatabases(true)
    job.treeSha256 = strict ? await sourceOperation(() => adapter.treeDigest(root)) : undefined
    const entries = selected(await sourceOperation(() => adapter.collect(root, options, true)), cookies !== undefined, offline)
    const planned: ArchiveEntry[] = []
    for (const entry of entries) {
      if (!isWithin(root, entry.sourcePath) || samePath(root, entry.sourcePath)) throw new Error('Selected backup source is outside its application root.')
      const info = await sourceOperation(() => assertOrdinaryPath(entry.sourcePath))
      planned.push({ ...entry, size: info.size, sha256: '' })
    }
    const total = validateArchiveSelection([...planned, { archivePath: 'manifest.json', sourcePath: '', size: 0, sha256: '' }])
    if (!entries.some(entry => entry.archivePath === 'settings.db')) throw new Error('Export failed: the archive is missing settings.db.')
    const archiveBound = Math.ceil(total * 1.01) + entries.length * 512 + MAX_MANIFEST_BYTES
    if (encrypt && archiveBound > SABK_MAX_PLAINTEXT_BYTES) throw new Error('SABK encryption is limited to 68719476704 archive bytes. Reduce the explicit selection.')
    checkDiskSpace([{ path: snapshot, bytes: total + archiveBound * (encrypt ? 3 : 1), purpose: '一致快照、归档及校验' }, { path: path.dirname(targetPath), bytes: archiveBound + (encrypt ? 65573 : 0), purpose: '备份目标' }])
    job.snapshotBytes = total
    job.progress = { phase: 'capturing-snapshot', completedBytes: 0, totalBytes: total }; saveBackupJob(job, control)
    atomicJson(path.join(backupJobDirectory(job.id, control.tempRoot), 'inventory.json'), planned.map(entry => ({ path: entry.archivePath, size: entry.size, state: 'pending' })))
    await adapter.hooks?.afterInventory?.(root, entries.map(entry => entry.archivePath))
    const sourceEntries: Record<string, string> = Object.create(null)
    const copied: ArchiveEntry[] = []
    const cancelled = () => backupCancellationRequested(job!, control.tempRoot)
    for (const entry of planned) {
      checkAbort(control.signal, cancelled)
      const target = path.join(snapshot, entry.archivePath)
      const captured = await sourceOperation(async () => {
        try { return await retryIo(() => copyFileVerified(entry.sourcePath, target, { signal: control.signal, cancelled }), control.signal) }
        catch (error) { const reason = error as NodeJS.ErrnoException; if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(reason.code ?? '')) throw new SnapshotUnavailableError(`Selected source file is missing or unreadable: ${entry.archivePath} (${reason.code})`); throw error }
      })
      if (captured.size !== entry.size) throw new SnapshotUnavailableError(`Selected source file changed during export: ${entry.archivePath}`)
      sourceEntries[entry.archivePath] = captured.sha256
      copied.push({ archivePath: entry.archivePath, sourcePath: target, ...captured })
      appendEntryState(job, { path: entry.archivePath, size: captured.size, sha256: captured.sha256, state: 'verified' }, control)
      job.progress.completedBytes += captured.size
      saveBackupJob(job, control)
    }
    const reverify = () => sourceOperation(async () => {
      if (!identityMatches(diskIdentity(root), job!.sourceIdentity)) throw new Error('Selected source data changed during export (root identity mismatch).')
      const after = selected(await adapter.collect(root, options, true), cookies !== undefined, offline)
      await adapter.verifySources(sourceEntries, entries, after)
      if (strict && adapter.treeDigest(root) !== job!.treeSha256) throw new Error('Selected source data changed during export (complete data tree digest mismatch).')
    })
    try { await adapter.validateSnapshot?.(snapshot) }
    catch (error) { await reverify(); throw error }
    if (adapter.cookieTransfer !== 'raw-profile') {
      if (offline) {
        const captured = await (await import('./sessions.js')).captureOfflineSensitiveData(copied, root, options.cookies, true)
        if (options.cookies) cookies = captured.snapshots
        sensitiveDrafts = captured.sensitiveDrafts
      } else sensitiveDrafts = (await import('./sensitive-drafts.js')).captureBackupDrafts(snapshot)
    }
    await reverify()
    for (const entry of copied) if (await hashFile(entry.sourcePath, control.signal, cancelled) !== entry.sha256) throw new Error(`Snapshot validation changed selected bytes: ${entry.archivePath}`)
    const now = new Date().toISOString()
    const manifest: BackupManifest = { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, edition: adapter.edition, dataSchemaVersion: DATA_SCHEMA_VERSION,
      deviceId: job.deviceId, appVersion: job.appVersion, exportedAt: now, options, entries: sourceEntries, cookieSnapshots: cookies, sensitiveDrafts,
      jobId: job.id, snapshotId: job.snapshotId, snapshotAt: now, inventory: copied.map(entry => ({ path: entry.archivePath, size: entry.size, sha256: entry.sha256, state: 'verified' })),
      cookieTransfer: cookies === undefined ? 'raw-profile' : 'portable-snapshot' }
    parseBackupManifest(manifest)
    if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) throw new Error('Backup manifest exceeds its documented size limit.')
    atomicJson(backupManifestPath(job, control.tempRoot), manifest)
    job.snapshotReady = true; job.progress = { phase: 'snapshot-ready', completedBytes: total, totalBytes: total }; saveBackupJob(job, control)
    if (strict) await adapter.hooks?.afterExport?.(root)
    else await preparation.onSnapshotReady?.()
    const result = await finishBackupJob(job, control, strict ? async () => { await adapter.hooks?.beforePublish?.(targetPath); await reverify() } : undefined)
    return result.status === 'recovery-required' ? { ...result, retryable: true } : result
  } catch (error) {
    if (job && unlock) {
      if (error instanceof SnapshotUnavailableError) {
        job.status = 'recovery-required'; job.error = error.message; saveBackupJob(job, control)
        return { ...backupJobResult(job, control.tempRoot), retryable: true }
      }
      return failBackupJob(job, error, control)
    }
    return { success: false, error: (error as Error).message, options, strict, skippedFiles: [] }
  } finally {
    unlock?.()
    if (job && temporaryIdentity) {
      try { discardTemporaryBackupJob(job, temporaryIdentity, control.tempRoot) }
      catch (error) { console.warn('[backup] Temporary task cleanup was deferred:', (error as Error).message) }
    }
  }
}
