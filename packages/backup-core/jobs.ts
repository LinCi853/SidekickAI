import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { encryptFileStream, decryptFileStream } from './file-crypto.js'
import { assertUnencryptedCredentialsAbsent } from './credential-export.js'
import { readStreamingArchive, writeStreamingArchive, type ArchiveEntry } from './stream-archive.js'
import { exportTreeDigest } from './files.js'
import { parseBackupManifest, safeBackupPath } from './format.js'
import { assertOrdinaryPath, assertPrivateDirectory, atomicJson, BackupCancelledError, BackupWaitingError, checkAbort, checkDiskSpace, COPY_CHUNK_BYTES, createPrivateDirectory, diskIdentity, flushFile, hashFile, identityMatches, isWithin, MAX_MANIFEST_BYTES, samePath, type DiskIdentity } from './io.js'
import type { BackupEdition, BackupManifest, BackupOptions } from './types.js'

export type BackupJobStatus = 'pending' | 'running' | 'waiting' | 'cancelled' | 'completed' | 'failed' | 'recovery-required'
export interface BackupProgress { phase: string; completedBytes: number; totalBytes: number }
export interface BackupBlock { offset: number; length: number; sha256: string }
export interface BackupTarget {
  path: string
  parentIdentity: DiskIdentity
  partialPath: string
  partialIdentity?: DiskIdentity
  checkpointId: string
  checkpointBytes: number
  completedBytes: number
  blockCount: number
  original?: { identity: DiskIdentity; size: number; sha256: string }
  publication?: { identity: DiskIdentity; completedBytes: number }
}
export interface BackupJob {
  version: 1
  id: string
  status: BackupJobStatus
  targetPath: string
  sourceRoot: string
  sourceIdentity: DiskIdentity
  snapshotId: string
  snapshotReady: boolean
  snapshotBytes: number
  edition: BackupEdition
  appVersion: string
  deviceId: string
  options: BackupOptions
  encrypted: boolean
  strict: boolean
  createdAt: string
  updatedAt: string
  progress: BackupProgress
  error?: string
  waitingReason?: string
  treeSha256?: string
  artifactSha256?: string
  artifactBytes?: number
  archiveSha256?: string
  transfer?: BackupTarget
  stagingPolicy: 'current-user-system-private-plaintext'
}
export interface BackupJobResult {
  success: boolean
  jobId: string
  snapshotId: string
  status: BackupJobStatus
  jobPath: string
  manifestPath: string
  filePath?: string
  error?: string
  waitingReason?: string
  sourceRoot: string
  sourceEntries?: Record<string, string>
  skippedFiles: string[]
  options: BackupOptions
  strict: boolean
  categories: string[]
  treeSha256?: string
  artifactSha256?: string
  sourceIdentity: DiskIdentity
}
export interface BackupJobControl {
  tempRoot?: string
  targetPath?: string
  password?: string
  signal?: AbortSignal
  onProgress?: (job: BackupJob) => void
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function defaultBackupJobRoot(): string {
  const override = process.env.SIDEKICK_BACKUP_JOB_ROOT
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('SIDEKICK_BACKUP_JOB_ROOT must be an absolute path.')
    return path.resolve(override)
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return path.join(local && path.isAbsolute(local) ? local : path.join(os.homedir(), 'AppData', 'Local'), 'SidekickAI', 'BackupJobs')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'SidekickAI', 'BackupJobs')
  const state = process.env.XDG_STATE_HOME
  return path.join(state && path.isAbsolute(state) ? state : path.join(os.homedir(), '.local', 'state'), 'SidekickAI', 'BackupJobs')
}
export function backupJobDirectory(id: string, tempRoot = defaultBackupJobRoot()): string {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid backup job identity.')
  return path.join(path.resolve(tempRoot), id)
}
export function backupSnapshotDirectory(job: BackupJob, tempRoot?: string): string { return path.join(backupJobDirectory(job.id, tempRoot), 'snapshot', job.snapshotId) }
export function backupManifestPath(job: BackupJob, tempRoot?: string): string { return path.join(backupJobDirectory(job.id, tempRoot), 'manifest.json') }

export function queryBackupJob(id: string, tempRoot?: string): BackupJob {
  const directory = backupJobDirectory(id, tempRoot)
  assertPrivateDirectory(directory)
  const file = path.join(directory, 'job.json')
  assertOrdinaryPath(file)
  if (fs.statSync(file).size > MAX_MANIFEST_BYTES) throw new Error('Backup task record exceeds its supported size.')
  const job = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupJob
  return validateBackupJob(job, id)
}

function validateBackupJob(job: BackupJob, id: string): BackupJob {
  if (job.version !== 1 || job.id !== id || !ID_PATTERN.test(job.snapshotId) || !path.isAbsolute(job.sourceRoot) || !path.isAbsolute(job.targetPath)
    || !job.sourceIdentity || typeof job.sourceIdentity.device !== 'string' || typeof job.sourceIdentity.inode !== 'string') throw new Error('Invalid backup job record.')
  if (!['pending', 'running', 'waiting', 'cancelled', 'completed', 'failed', 'recovery-required'].includes(job.status)
    || !['community', 'concept'].includes(job.edition) || typeof job.updatedAt !== 'string' || typeof job.createdAt !== 'string'
    || !job.progress || typeof job.progress.phase !== 'string' || !Number.isSafeInteger(job.progress.completedBytes) || job.progress.completedBytes < 0
    || !Number.isSafeInteger(job.progress.totalBytes) || job.progress.totalBytes < 0 || !Number.isSafeInteger(job.snapshotBytes) || job.snapshotBytes < 0
    || !job.options || job.options.basicData !== true || ['cookies', 'indexedDB', 'cache'].some(key => typeof job.options[key as keyof BackupOptions] !== 'boolean')
    || ['snapshotReady', 'encrypted', 'strict'].some(key => typeof job[key as keyof BackupJob] !== 'boolean')
    || job.error !== undefined && typeof job.error !== 'string' || job.waitingReason !== undefined && typeof job.waitingReason !== 'string') throw new Error('Invalid backup job state.')
  if (job.transfer && (!samePath(job.transfer.path, job.targetPath) || !samePath(path.dirname(job.transfer.partialPath), path.dirname(job.targetPath))
    || path.basename(job.transfer.partialPath) !== `.${path.basename(job.targetPath)}.${job.id}.partial` || !ID_PATTERN.test(job.transfer.checkpointId)
    || !Number.isSafeInteger(job.transfer.checkpointBytes) || job.transfer.checkpointBytes < 0 || !Number.isSafeInteger(job.transfer.completedBytes) || job.transfer.completedBytes < 0
    || !Number.isSafeInteger(job.transfer.blockCount) || job.transfer.blockCount < 0)) throw new Error('Invalid backup target checkpoint.')
  if (job.transfer?.publication && (!job.transfer.publication.identity || typeof job.transfer.publication.identity.device !== 'string'
    || typeof job.transfer.publication.identity.inode !== 'string' || !Number.isSafeInteger(job.transfer.publication.completedBytes)
    || job.transfer.publication.completedBytes < 0 || job.transfer.publication.completedBytes > (job.artifactBytes ?? 0))) throw new Error('Invalid backup publication checkpoint.')
  if (job.transfer?.partialIdentity && (typeof job.transfer.partialIdentity.device !== 'string' || typeof job.transfer.partialIdentity.inode !== 'string')) throw new Error('Invalid backup partial file identity.')
  return job
}

export function listBackupJobs(tempRoot = defaultBackupJobRoot()): BackupJob[] {
  if (!fs.existsSync(tempRoot)) return []
  assertOrdinaryPath(tempRoot, true)
  return fs.readdirSync(tempRoot).filter(name => ID_PATTERN.test(name)).map(id => queryBackupJob(id, tempRoot)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function saveBackupJob(job: BackupJob, control: BackupJobControl = {}): void {
  job.updatedAt = new Date().toISOString()
  atomicJson(path.join(backupJobDirectory(job.id, control.tempRoot), 'job.json'), job)
  control.onProgress?.(structuredClone(job))
}

export function createBackupJob(input: Omit<BackupJob, 'version' | 'id' | 'status' | 'snapshotId' | 'snapshotReady' | 'snapshotBytes' | 'createdAt' | 'updatedAt' | 'progress' | 'stagingPolicy'> & { jobId?: string }, control: BackupJobControl = {}): BackupJob {
  const root = path.resolve(control.tempRoot ?? defaultBackupJobRoot())
  if (isWithin(input.sourceRoot, root) || isWithin(input.sourceRoot, input.targetPath)) throw new Error('Backup staging and output must be outside the application data root.')
  const id = input.jobId ?? randomUUID()
  const directory = backupJobDirectory(id, root)
  if (fs.existsSync(directory)) return queryBackupJob(id, root)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  assertOrdinaryPath(root, true)
  createPrivateDirectory(directory)
  const now = new Date().toISOString()
  const { jobId: _requested, ...fields } = input
  const job: BackupJob = { ...fields, version: 1, id, status: 'pending', snapshotId: randomUUID(), snapshotReady: false, snapshotBytes: 0,
    createdAt: now, updatedAt: now, progress: { phase: 'pending', completedBytes: 0, totalBytes: 0 }, stagingPolicy: 'current-user-system-private-plaintext' }
  saveBackupJob(job, { ...control, tempRoot: root })
  return job
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
export function lockBackupJob(job: BackupJob, tempRoot?: string): () => void {
  const lock = path.join(backupJobDirectory(job.id, tempRoot), 'lock.json')
  if (fs.existsSync(lock)) {
    const existing = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number }
    if (!Number.isSafeInteger(existing.pid) || alive(existing.pid)) throw new BackupWaitingError('busy', '此备份任务正在执行，请等待当前操作。')
    fs.unlinkSync(lock)
  }
  const token = randomUUID()
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  return () => {
    if (fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock)
  }
}

export function backupCancellationRequested(job: BackupJob, tempRoot?: string): boolean { return fs.existsSync(path.join(backupJobDirectory(job.id, tempRoot), 'cancel')) }

/** Discard only the current application's verified, inactive temporary task. */
export function discardTemporaryBackupJob(expected: BackupJob, directoryIdentity: DiskIdentity, tempRoot?: string): void {
  if (expected.strict) throw new Error('Maintenance backup receipts must be retained.')
  const directory = backupJobDirectory(expected.id, tempRoot)
  assertOrdinaryPath(directory, true)
  if (!identityMatches(diskIdentity(directory), directoryIdentity)) throw new Error('Backup task directory identity changed before cleanup.')
  const job = queryBackupJob(expected.id, tempRoot)
  if (job.strict || job.edition !== expected.edition || job.snapshotId !== expected.snapshotId
    || !samePath(job.sourceRoot, expected.sourceRoot) || !samePath(job.targetPath, expected.targetPath)
    || !identityMatches(job.sourceIdentity, expected.sourceIdentity)
    || isWithin(directory, job.targetPath) || isWithin(directory, job.sourceRoot)) throw new Error('Backup task ownership changed before cleanup.')
  const unlock = lockBackupJob(job, tempRoot)
  try {
    if (!identityMatches(diskIdentity(directory), directoryIdentity)) throw new Error('Backup task directory identity changed before cleanup.')
    if (job.transfer && fs.existsSync(job.transfer.partialPath)) {
      assertOwnedPartial(job.transfer)
      fs.unlinkSync(job.transfer.partialPath)
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } finally { unlock() }
}

export function cancelBackupJob(id: string, tempRoot?: string, options: { discard?: boolean } = {}): BackupJob {
  const job = queryBackupJob(id, tempRoot)
  const directory = backupJobDirectory(id, tempRoot)
  fs.writeFileSync(path.join(directory, 'cancel'), 'cancelled', { mode: 0o600 })
  const lock = path.join(directory, 'lock.json')
  const running = fs.existsSync(lock) && alive(JSON.parse(fs.readFileSync(lock, 'utf8')).pid)
  if (options.discard) {
    if (running) throw new BackupWaitingError('busy', '正在停止备份，停止后才能丢弃暂存。')
    if (job.transfer && fs.existsSync(job.transfer.partialPath)) {
      assertOwnedPartial(job.transfer)
      fs.unlinkSync(job.transfer.partialPath)
    }
    assertOrdinaryPath(directory, true)
    fs.rmSync(directory, { recursive: true, force: true })
    return { ...job, status: 'cancelled' }
  }
  if (!running && job.status !== 'completed') { job.status = 'cancelled'; job.error = '备份已暂停并保留进度。'; saveBackupJob(job, { tempRoot }) }
  return job
}

export function backupJobResult(job: BackupJob, tempRoot?: string): BackupJobResult {
  const manifestPath = backupManifestPath(job, tempRoot)
  const manifest = job.snapshotReady && fs.existsSync(manifestPath) ? parseBackupManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) : undefined
  return { success: job.status === 'completed', jobId: job.id, snapshotId: job.snapshotId, status: job.status, jobPath: path.join(backupJobDirectory(job.id, tempRoot), 'job.json'), manifestPath,
    filePath: job.status === 'completed' ? job.targetPath : undefined, error: job.error, waitingReason: job.waitingReason,
    sourceRoot: job.sourceRoot, sourceEntries: manifest?.entries, skippedFiles: [], options: job.options, strict: job.strict,
    categories: ['basicData', 'cookies', 'indexedDB', 'cache'].filter(key => job.options[key as keyof BackupOptions]), treeSha256: job.treeSha256, artifactSha256: job.artifactSha256, sourceIdentity: job.sourceIdentity }
}

export function failBackupJob(job: BackupJob, error: unknown, control: BackupJobControl = {}): BackupJobResult {
  const reason = error as NodeJS.ErrnoException
  job.error = reason.message ?? String(error)
  job.waitingReason = error instanceof BackupWaitingError ? error.reason : ['ENOSPC', 'EDQUOT'].includes(reason.code ?? '') ? 'space' : ['ENOENT', 'ENODEV', 'ENXIO', 'EIO', 'ENETUNREACH', 'ECONNRESET', 'EACCES', 'EPERM', 'EBUSY'].includes(reason.code ?? '') ? 'storage' : undefined
  job.status = error instanceof BackupCancelledError || reason.name === 'AbortError' ? 'cancelled' : job.waitingReason ? 'waiting' : 'failed'
  saveBackupJob(job, control)
  return backupJobResult(job, control.tempRoot)
}

function snapshotEntries(job: BackupJob, control: BackupJobControl): { manifest: BackupManifest; entries: ArchiveEntry[] } {
  const manifest = parseBackupManifest(JSON.parse(fs.readFileSync(backupManifestPath(job, control.tempRoot), 'utf8')))
  if (manifest.jobId !== job.id || manifest.snapshotId !== job.snapshotId) throw new Error('Backup snapshot identity does not match its task.')
  const sizes = new Map((manifest.inventory ?? []).map(entry => [entry.path, entry.size]))
  const snapshot = backupSnapshotDirectory(job, control.tempRoot)
  const entries = Object.entries(manifest.entries).map(([archivePath, sha256]) => {
    if (!safeBackupPath(archivePath)) throw new Error('Invalid snapshot entry path.')
    const sourcePath = path.join(snapshot, archivePath)
    const size = sizes.get(archivePath)
    if (!Number.isSafeInteger(size) || size! < 0) throw new Error('Snapshot entry is missing its verified size.')
    return { archivePath, sourcePath, size: size!, sha256 }
  })
  return { manifest, entries }
}

async function verifySnapshot(job: BackupJob, control: BackupJobControl): Promise<{ manifest: BackupManifest; entries: ArchiveEntry[] }> {
  const payload = snapshotEntries(job, control)
  let completed = 0
  job.progress = { phase: 'verifying-snapshot', completedBytes: 0, totalBytes: job.snapshotBytes }
  saveBackupJob(job, control)
  for (const entry of payload.entries) {
    checkAbort(control.signal, () => backupCancellationRequested(job, control.tempRoot))
    const info = assertOrdinaryPath(entry.sourcePath)
    if (info.size !== entry.size || await hashFile(entry.sourcePath, control.signal, () => backupCancellationRequested(job, control.tempRoot)) !== entry.sha256) throw new Error(`Saved snapshot integrity check failed: ${entry.archivePath}`)
    completed += entry.size
    job.progress.completedBytes = completed
  }
  saveBackupJob(job, control)
  return payload
}

async function prepareArtifact(job: BackupJob, control: BackupJobControl): Promise<string> {
  const directory = backupJobDirectory(job.id, control.tempRoot)
  const checkedSnapshot = !job.encrypted ? await verifySnapshot(job, control) : undefined
  if (checkedSnapshot) assertUnencryptedCredentialsAbsent(backupSnapshotDirectory(job, control.tempRoot))
  const artifact = path.join(directory, job.encrypted ? 'artifact.sabackup' : 'artifact.zip')
  const cancelled = () => backupCancellationRequested(job, control.tempRoot)
  if (job.artifactSha256 && fs.existsSync(artifact)) {
    if (fs.statSync(artifact).size !== job.artifactBytes || await hashFile(artifact, control.signal, cancelled) !== job.artifactSha256) throw new Error('The retained backup artifact has changed.')
    return artifact
  }
  const { manifest, entries } = checkedSnapshot ?? await verifySnapshot(job, control)
  const archive = path.join(directory, 'archive.zip')
  const upperBound = Math.ceil(job.snapshotBytes * 1.01) + entries.length * 512 + MAX_MANIFEST_BYTES
  checkDiskSpace([{ path: directory, bytes: upperBound * (job.encrypted ? 3 : 1), purpose: '打包与验证' }])
  const progress = (phase: string) => (bytes: number, total = job.snapshotBytes) => {
    job.progress = { phase, completedBytes: bytes, totalBytes: total }
    control.onProgress?.(structuredClone(job))
  }
  const validArchive = job.archiveSha256 && fs.existsSync(archive) && await hashFile(archive, control.signal, cancelled) === job.archiveSha256
  if (!validArchive) {
    job.progress = { phase: 'archiving', completedBytes: 0, totalBytes: job.snapshotBytes }; saveBackupJob(job, control)
    await writeStreamingArchive(archive, entries, manifest, { signal: control.signal, cancelled, onBytes: progress('archiving') })
    await readStreamingArchive(archive, { signal: control.signal, cancelled, onBytes: progress('verifying-archive') })
    job.archiveSha256 = await hashFile(archive, control.signal, cancelled)
    saveBackupJob(job, control)
  }
  if (job.encrypted) {
    if (!control.password) throw new BackupWaitingError('password', '需要重新输入密码后继续加密；已验证快照与归档已保留。')
    job.progress = { phase: 'encrypting', completedBytes: 0, totalBytes: fs.statSync(archive).size }; saveBackupJob(job, control)
    await encryptFileStream(archive, artifact, control.password, job.deviceId, { signal: control.signal, cancelled, onBytes: progress('encrypting',) })
    const verified = path.join(directory, 'verified.zip')
    try {
      if (await decryptFileStream(artifact, verified, control.password, { signal: control.signal, cancelled, onBytes: progress('verifying-encryption') }) !== job.deviceId
        || await hashFile(verified, control.signal, cancelled) !== job.archiveSha256) throw new Error('Encrypted backup verification failed.')
      await readStreamingArchive(verified, { signal: control.signal, cancelled, onBytes: progress('verifying-encryption') })
    } finally { fs.rmSync(verified, { force: true }) }
  } else {
    if (fs.existsSync(artifact)) fs.unlinkSync(artifact)
    fs.renameSync(archive, artifact)
  }
  job.artifactBytes = fs.statSync(artifact).size
  job.artifactSha256 = await hashFile(artifact, control.signal, cancelled)
  saveBackupJob(job, control)
  return artifact
}

async function originalTarget(file: string): Promise<BackupTarget['original']> {
  if (!fs.existsSync(file)) return undefined
  const info = assertOrdinaryPath(file)
  return { identity: diskIdentity(file), size: info.size, sha256: await hashFile(file) }
}

export async function prepareBackupTarget(job: BackupJob, control: BackupJobControl = {}): Promise<void> {
  if (control.targetPath && !samePath(control.targetPath, job.targetPath)) {
    if (isWithin(job.sourceRoot, control.targetPath) || isWithin(backupJobDirectory(job.id, control.tempRoot), control.targetPath)) throw new Error('Backup output must be outside the source and staging directories.')
    job.targetPath = path.resolve(control.targetPath)
    job.transfer = undefined
  }
  const parent = path.dirname(job.targetPath)
  assertOrdinaryPath(parent, true)
  const parentIdentity = diskIdentity(parent)
  if (job.transfer) {
    if (!identityMatches(parentIdentity, job.transfer.parentIdentity)) throw new BackupWaitingError('device-changed', '同一路径的目标设备或目录已变化，请明确选择新的保存位置。')
    return
  }
  const original = await originalTarget(job.targetPath)
  if (job.strict && original) throw new BackupWaitingError('target-exists', 'Backup destination already exists. 严格备份目标已存在，请选择新的保存位置。')
  job.transfer = { path: job.targetPath, parentIdentity, partialPath: path.join(parent, `.${path.basename(job.targetPath)}.${job.id}.partial`), checkpointId: randomUUID(), checkpointBytes: 0, completedBytes: 0, blockCount: 0, original }
  saveBackupJob(job, control)
}

async function hashRange(file: fs.promises.FileHandle, offset: number, length: number): Promise<string> {
  const bytes = Buffer.allocUnsafe(length)
  let read = 0
  while (read < length) { const result = await file.read(bytes, read, length - read, offset + read); if (!result.bytesRead) throw new Error('A retained backup block is incomplete.'); read += result.bytesRead }
  return createHash('sha256').update(bytes).digest('hex')
}

function assertOwnedPartial(transfer: BackupTarget): void {
  if (!identityMatches(diskIdentity(path.dirname(transfer.path)), transfer.parentIdentity)) throw new BackupWaitingError('device-changed', '目标设备或目录已变化，未修改断点文件。')
  if (!transfer.partialIdentity || !fs.existsSync(transfer.partialPath)) throw new BackupWaitingError('target-changed', '无法确认断点文件归属，原文件已保留，请选择新的保存位置。')
  assertOrdinaryPath(transfer.partialPath)
  if (!identityMatches(diskIdentity(transfer.partialPath), transfer.partialIdentity)) throw new BackupWaitingError('target-changed', '断点文件已被替换，未覆盖或删除现有文件，请选择新的保存位置。')
}

async function verifyPublicationSource(job: BackupJob, beforePublish?: () => Promise<void>): Promise<void> {
  await beforePublish?.()
  if (job.strict && (!identityMatches(diskIdentity(job.sourceRoot), job.sourceIdentity) || !job.treeSha256 || exportTreeDigest(job.sourceRoot) !== job.treeSha256)) {
    throw new Error('Strict backup source changed before publication; a new snapshot is required.')
  }
}

async function publishStrictArtifact(job: BackupJob, artifact: string, control: BackupJobControl): Promise<void> {
  const transfer = job.transfer!
  if (!transfer.publication) {
    try { fs.linkSync(transfer.partialPath, job.targetPath); flushFile(job.targetPath); return }
    catch (error) {
      if (!['EXDEV', 'ENOSYS', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  const cancelled = () => backupCancellationRequested(job, control.tempRoot)
  const ownedIdentity = () => {
    if (!identityMatches(diskIdentity(path.dirname(job.targetPath)), transfer.parentIdentity)) throw new BackupWaitingError('device-changed', '发布目标设备或目录已变化，断点已保留。')
    assertOrdinaryPath(job.targetPath)
    if (!identityMatches(diskIdentity(job.targetPath), transfer.publication!.identity)) throw new BackupWaitingError('target-changed', '发布中的目标文件已被替换；原文件与断点均已保留，请选择新的保存位置。')
  }
  if (transfer.publication) ownedIdentity()
  const output = await fs.promises.open(job.targetPath, transfer.publication ? 'r+' : 'wx+', 0o600)
  let input: fs.promises.FileHandle | undefined
  try {
    const info = await output.stat({ bigint: true })
    const identity = { device: String(info.dev), inode: String(info.ino) }
    if (!transfer.publication) {
      await output.sync()
      transfer.publication = { identity, completedBytes: 0 }
      saveBackupJob(job, control)
    }
    if (!identityMatches(identity, transfer.publication.identity)) throw new BackupWaitingError('target-changed', '发布目标身份已变化，未覆盖现有文件。')
    ownedIdentity()
    input = await fs.promises.open(artifact, 'r')
    let offset = 0
    while (offset < transfer.publication.completedBytes) {
      checkAbort(control.signal, cancelled)
      const length = Math.min(COPY_CHUNK_BYTES, transfer.publication.completedBytes - offset)
      if (await hashRange(output, offset, length) !== await hashRange(input, offset, length)) throw new BackupWaitingError('target-changed', '发布目标中已确认的内容发生变化，未覆盖现有文件。')
      offset += length
    }
    ownedIdentity()
    await output.truncate(offset)
    checkDiskSpace([{ path: path.dirname(job.targetPath), bytes: job.artifactBytes! - offset, purpose: '备份独占发布续传' }])
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    job.progress = { phase: 'publishing', completedBytes: offset, totalBytes: job.artifactBytes! }; saveBackupJob(job, control)
    while (offset < job.artifactBytes!) {
      checkAbort(control.signal, cancelled)
      ownedIdentity()
      const length = Math.min(buffer.length, job.artifactBytes! - offset)
      let read = 0
      while (read < length) { const result = await input.read(buffer, read, length - read, offset + read); if (!result.bytesRead) throw new Error('Backup artifact became shorter.'); read += result.bytesRead }
      let written = 0
      while (written < length) { const result = await output.write(buffer, written, length - written, offset + written); if (!result.bytesWritten) throw new Error('Backup publication made no progress.'); written += result.bytesWritten }
      await output.sync()
      if (await hashRange(output, offset, length) !== createHash('sha256').update(buffer.subarray(0, length)).digest('hex')) throw new Error('Published backup block failed verification.')
      offset += length
      transfer.publication.completedBytes = offset
      job.progress.completedBytes = offset
      saveBackupJob(job, control)
    }
    ownedIdentity()
  } finally { await input?.close(); await output.close() }
}

async function transferArtifact(job: BackupJob, artifact: string, control: BackupJobControl, beforePublish?: () => Promise<void>): Promise<void> {
  await prepareBackupTarget(job, control)
  const transfer = job.transfer!
  const cancelled = () => backupCancellationRequested(job, control.tempRoot)
  const total = job.artifactBytes!
  const checkpoint = path.join(backupJobDirectory(job.id, control.tempRoot), `blocks-${transfer.checkpointId}.jsonl`)
  if (job.progress.phase === 'publishing' && fs.existsSync(job.targetPath) && await hashFile(job.targetPath, control.signal, cancelled) === job.artifactSha256) {
    await verifyPublicationSource(job, beforePublish)
    return
  }
  const exists = fs.existsSync(transfer.partialPath)
  if (exists) assertOwnedPartial(transfer)
  else if (transfer.partialIdentity || transfer.blockCount) throw new BackupWaitingError('target-changed', '原断点文件已不在记录位置，请选择新的保存位置。')
  const output = await fs.promises.open(transfer.partialPath, exists ? 'r+' : 'wx+', 0o600)
  const input = await fs.promises.open(artifact, 'r').catch(async error => { await output.close(); throw error })
  let offset = 0
  try {
    const info = await output.stat({ bigint: true })
    const identity = { device: String(info.dev), inode: String(info.ino) }
    if (!transfer.partialIdentity) {
      await output.sync()
      transfer.partialIdentity = identity
      saveBackupJob(job, control)
    }
    if (!identityMatches(identity, transfer.partialIdentity)) throw new BackupWaitingError('target-changed', '打开的断点文件身份已变化，未修改现有文件。')
    assertOwnedPartial(transfer)
    if (transfer.blockCount) {
      if (!fs.existsSync(checkpoint) || fs.statSync(checkpoint).size < transfer.checkpointBytes) throw new Error('Backup block checkpoint is missing or truncated.')
      let count = 0
      const lines = createInterface({ input: fs.createReadStream(checkpoint, { end: transfer.checkpointBytes - 1 }), crlfDelay: Infinity })
      for await (const line of lines) {
        checkAbort(control.signal, cancelled)
        if (line.length > 1024) throw new Error('Backup block checkpoint is invalid.')
        const block = JSON.parse(line) as BackupBlock
        if (block.offset !== offset || block.length <= 0 || block.length > COPY_CHUNK_BYTES || block.offset + block.length > total
          || await hashRange(output, block.offset, block.length) !== block.sha256 || await hashRange(input, block.offset, block.length) !== block.sha256) throw new Error('A retained backup block failed verification.')
        offset += block.length
        count++
      }
      if (count !== transfer.blockCount || offset !== transfer.completedBytes) throw new Error('Backup block checkpoint does not match its task.')
    }
    if (fs.existsSync(checkpoint)) fs.truncateSync(checkpoint, transfer.checkpointBytes)
    assertOwnedPartial(transfer)
    await output.truncate(offset)
    checkDiskSpace([{ path: path.dirname(job.targetPath), bytes: total - offset, purpose: '备份目标续传' }])
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    job.progress = { phase: 'copying-target', completedBytes: offset, totalBytes: total }; saveBackupJob(job, control)
    while (offset < total) {
      checkAbort(control.signal, cancelled)
      assertOwnedPartial(transfer)
      const length = Math.min(buffer.length, total - offset)
      let read = 0
      while (read < length) { const result = await input.read(buffer, read, length - read, offset + read); if (!result.bytesRead) throw new Error('Backup artifact became shorter.'); read += result.bytesRead }
      let written = 0
      while (written < length) { const result = await output.write(buffer, written, length - written, offset + written); if (!result.bytesWritten) throw new Error('Backup destination write made no progress.'); written += result.bytesWritten }
      await output.sync()
      const sha256 = createHash('sha256').update(buffer.subarray(0, length)).digest('hex')
      if (await hashRange(output, offset, length) !== sha256) throw new Error('Copied backup block failed verification.')
      const row = Buffer.from(JSON.stringify({ offset, length, sha256 }) + '\n')
      const log = fs.openSync(checkpoint, 'a', 0o600)
      try { fs.writeFileSync(log, row); fs.fsyncSync(log) } finally { fs.closeSync(log) }
      offset += length
      transfer.checkpointBytes += row.length
      transfer.blockCount++
      transfer.completedBytes = offset
      job.progress.completedBytes = offset
      saveBackupJob(job, control)
    }
  } finally { await input.close(); await output.close() }
  assertOwnedPartial(transfer)
  if (await hashFile(transfer.partialPath, control.signal, cancelled) !== job.artifactSha256) throw new Error('Backup destination verification failed.')
  checkAbort(control.signal, cancelled)
  await verifyPublicationSource(job, beforePublish)
  const current = await originalTarget(job.targetPath)
  if (!transfer.publication && JSON.stringify(current) !== JSON.stringify(transfer.original)) throw new BackupWaitingError('target-changed', 'Backup destination changed or already exists. 目标文件已被其他操作修改，原文件与备份断点均已保留，请选择新的位置。')
  job.progress = { phase: 'publishing', completedBytes: total, totalBytes: total }; saveBackupJob(job, control)
  assertOwnedPartial(transfer)
  if (job.strict) { await publishStrictArtifact(job, artifact, control); assertOwnedPartial(transfer); fs.unlinkSync(transfer.partialPath) }
  else fs.renameSync(transfer.partialPath, job.targetPath)
  if (await hashFile(job.targetPath, control.signal) !== job.artifactSha256) throw new Error('Published backup no longer matches its verified artifact.')
  await verifyPublicationSource(job)
}

export async function finishBackupJob(job: BackupJob, control: BackupJobControl = {}, beforePublish?: () => Promise<void>): Promise<BackupJobResult> {
  job.status = 'running'; job.error = undefined; job.waitingReason = undefined
  saveBackupJob(job, control)
  try {
    checkAbort(control.signal, () => backupCancellationRequested(job, control.tempRoot))
    if (!job.snapshotReady) throw new BackupWaitingError('snapshot-required', '尚未完成一致快照，需要保存应用并重新协调捕获。')
    const artifact = await prepareArtifact(job, control)
    await transferArtifact(job, artifact, control, beforePublish)
    job.status = 'completed'; job.error = undefined; job.waitingReason = undefined
    job.progress = { phase: 'completed', completedBytes: job.artifactBytes!, totalBytes: job.artifactBytes! }
    saveBackupJob(job, control)
    return backupJobResult(job, control.tempRoot)
  } catch (error) {
    if (job.strict && /source.*changed|source.*identity/i.test((error as Error).message)) {
      job.status = 'recovery-required'; job.snapshotReady = false; job.error = (error as Error).message; saveBackupJob(job, control)
      return backupJobResult(job, control.tempRoot)
    }
    return failBackupJob(job, error, control)
  }
}

export async function resumeBackupJob(id: string, control: BackupJobControl = {}): Promise<BackupJobResult> {
  const job = queryBackupJob(id, control.tempRoot)
  let unlock: (() => void) | undefined
  try {
    unlock = lockBackupJob(job, control.tempRoot)
    if (job.status === 'completed' && !control.targetPath) {
      if (!fs.existsSync(job.targetPath) || await hashFile(job.targetPath, control.signal) !== job.artifactSha256) throw new BackupWaitingError('target-changed', '已完成的备份文件已变化或不在原位置，请选择新位置从保留成品继续复制。')
      return backupJobResult(job, control.tempRoot)
    }
    fs.rmSync(path.join(backupJobDirectory(id, control.tempRoot), 'cancel'), { force: true })
    if (!job.snapshotReady) {
      job.status = 'recovery-required'; job.error = '需要保存应用并重新协调捕获；未将未完成快照当作可续传成品。'; saveBackupJob(job, control)
      return backupJobResult(job, control.tempRoot)
    }
    return await finishBackupJob(job, control)
  } catch (error) {
    if (!unlock) return { ...backupJobResult(job, control.tempRoot), success: false, error: (error as Error).message, waitingReason: 'busy' }
    return failBackupJob(job, error, control)
  }
  finally { unlock?.() }
}
