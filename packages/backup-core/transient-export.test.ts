import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportBackup, type ExportAdapter, type ExportPreparation } from './export.js'
import { backupJobDirectory, createBackupJob, lockBackupJob, queryBackupJob, resumeBackupJob } from './jobs.js'
import { diskIdentity } from './io.js'
import { validateBackupArchive } from './format.js'
import AdmZip from 'adm-zip'
import { exportTreeDigest } from './files.js'
import { decryptFile } from './file-crypto.js'
import Database from 'better-sqlite3'

let root = ''
const options = { basicData: true, cookies: false, indexedDB: false, cache: false }
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'transient-backup-')); vi.stubEnv('SIDEKICK_BACKUP_JOB_ROOT', path.join(root, 'jobs')) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function fixture() {
  const source = path.join(root, 'source'); fs.mkdirSync(source)
  const settings = path.join(source, 'settings.db')
  const database = new Database(settings)
  try { database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)') }
  finally { database.close() }
  const target = path.join(root, 'backup.zip')
  const adapter: ExportAdapter = {
    edition: 'community', root: () => source, version: () => 'fixture', deviceId: () => 'fixture', cookieTransfer: 'raw-profile',
    closeDatabases: async () => {}, collect: async () => [{ category: 'basicData', sourcePath: settings, archivePath: 'settings.db' }],
    validate: () => {}, treeDigest: exportTreeDigest, verifySources: () => {},
  }
  return { source, target, adapter }
}
function transient(extra: ExportPreparation = {}): ExportPreparation { return { ...extra, cleanup: true } }
it('removes only its completed default staging and retains the verified final archive', async () => {
  const entry = fixture()
  const other = createBackupJob({ sourceRoot: entry.source, sourceIdentity: diskIdentity(entry.source), targetPath: path.join(root, 'other.zip'), edition: 'community', appVersion: 'fixture', deviceId: 'fixture', options, encrypted: false, strict: false })
  const result = await exportBackup(entry.adapter, entry.target, options, undefined, transient())
  expect(result.success).toBe(true)
  expect(validateBackupArchive(new AdmZip(entry.target)).entries['settings.db']).toMatch(/^[a-f0-9]{64}$/)
  expect(fs.existsSync(backupJobDirectory(result.jobId!))).toBe(false)
  expect(queryBackupJob(other.id).id).toBe(other.id)
  expect(fs.existsSync(entry.source)).toBe(true)
})
it('removes failed own snapshot without changing the existing user backup', async () => {
  const entry = fixture(); fs.writeFileSync(entry.target, 'existing user backup')
  entry.adapter.validateSnapshot = () => { throw new Error('Invalid source database') }
  const result = await exportBackup(entry.adapter, entry.target, options, undefined, transient())
  expect(result.success).toBe(false)
  expect(fs.readFileSync(entry.target, 'utf8')).toBe('existing user backup')
  expect(fs.existsSync(backupJobDirectory(result.jobId!))).toBe(false)
})
it('keeps an authenticated encrypted backup after releasing plaintext staging', async () => {
  const entry = fixture()
  const result = await exportBackup(entry.adapter, entry.target, options, { password: 'isolated-password' }, transient())
  expect(result.success).toBe(true)
  const decoded = path.join(root, 'verified.zip')
  expect(decryptFile(entry.target, decoded, 'isolated-password')).toBe('fixture')
  expect(validateBackupArchive(new AdmZip(decoded)).options).toEqual(options)
  expect(fs.existsSync(backupJobDirectory(result.jobId!))).toBe(false)
})
it('removes its owned incomplete publication after cancellation and preserves the target', async () => {
  const entry = fixture(); fs.writeFileSync(entry.target, 'previous backup')
  const controller = new AbortController()
  let partial = ''
  const result = await exportBackup(entry.adapter, entry.target, options, undefined, transient({ signal: controller.signal, onProgress: job => {
    if (job.progress.phase === 'copying-target') { partial = job.transfer!.partialPath; controller.abort() }
  } }))
  expect(result.success).toBe(false)
  expect(result.status).toBe('cancelled')
  expect(partial).not.toBe('')
  expect(fs.existsSync(partial)).toBe(false)
  expect(fs.existsSync(backupJobDirectory(result.jobId!))).toBe(false)
  expect(fs.readFileSync(entry.target, 'utf8')).toBe('previous backup')
})
it('retains strict and durable jobs for existing maintenance and resume consumers', async () => {
  const entry = fixture()
  const strict = await exportBackup(entry.adapter, entry.target, options, undefined, transient({ strict: true, expectedDataRoot: entry.source }))
  expect(strict.success).toBe(true)
  expect(queryBackupJob(strict.jobId!).status).toBe('completed')
  const durable = await exportBackup(entry.adapter, path.join(root, 'durable.zip'), options)
  expect(durable.success).toBe(true)
  expect(queryBackupJob(durable.jobId!).status).toBe('completed')
  expect((await resumeBackupJob(durable.jobId!)).success).toBe(true)
})
it('does not delete a running job supplied by another caller', async () => {
  const entry = fixture()
  const job = createBackupJob({ sourceRoot: entry.source, sourceIdentity: diskIdentity(entry.source), targetPath: entry.target, edition: 'community', appVersion: 'fixture', deviceId: 'fixture', options, encrypted: false, strict: false })
  const unlock = lockBackupJob(job)
  try {
    expect((await exportBackup(entry.adapter, entry.target, options, undefined, transient({ jobId: job.id }))).success).toBe(false)
    expect(fs.existsSync(path.join(backupJobDirectory(job.id), 'lock.json'))).toBe(true)
    expect(fs.existsSync(path.join(backupJobDirectory(job.id), 'cancel'))).toBe(false)
  } finally { unlock() }
})
it('does not remove a replaced publication partial while cleaning up a failed export', async () => {
  const entry = fixture()
  let partial = ''
  const result = await exportBackup(entry.adapter, entry.target, options, undefined, transient({ onProgress: job => {
    if (job.progress.phase !== 'copying-target' || partial) return
    partial = job.transfer!.partialPath
    fs.renameSync(partial, `${partial}.original`)
    fs.writeFileSync(partial, 'unrelated replacement')
    throw new Error('Interrupted publication')
  } }))
  expect(result.success).toBe(false)
  expect(partial).not.toBe('')
  expect(fs.readFileSync(partial, 'utf8')).toBe('unrelated replacement')
  expect(fs.existsSync(entry.source)).toBe(true)
})
it('retains a replaced staging directory instead of deleting unknown bytes', async () => {
  const entry = fixture()
  let replaced = ''
  const result = await exportBackup(entry.adapter, entry.target, options, undefined, transient({ onProgress: job => {
    if (job.status !== 'completed' || replaced) return
    replaced = backupJobDirectory(job.id)
    fs.renameSync(replaced, `${replaced}.original`)
    fs.cpSync(`${replaced}.original`, replaced, { recursive: true })
    fs.writeFileSync(path.join(replaced, 'unrelated.txt'), 'replacement')
  } }))
  expect(result.success).toBe(true)
  expect(fs.readFileSync(path.join(replaced, 'unrelated.txt'), 'utf8')).toBe('replacement')
  expect(fs.existsSync(`${replaced}.original`)).toBe(true)
  expect(validateBackupArchive(new AdmZip(entry.target)).formatVersion).toBe(1)
})
