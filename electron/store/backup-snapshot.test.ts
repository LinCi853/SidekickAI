import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import { exportBackup, type ExportAdapter } from '../../packages/backup-core/export.js'
import { exportTreeDigest, writePartialArchive, writeStrictArchive } from '../../packages/backup-core/files.js'
import { validateBackupArchive } from '../../packages/backup-core/format.js'
import { verifyQuiescentSnapshot } from './backup/verify.js'

vi.mock('electron', () => ({ app: { isReady: () => true, getPath: () => os.tmpdir() }, session: {} }))
const roots: string[] = []
const options = { basicData: true, cookies: false, indexedDB: false, cache: false }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-snapshot-contract-'))
  roots.push(directory)
  const source = path.join(directory, 'source')
  fs.mkdirSync(source)
  const settings = path.join(source, 'settings.db')
  const database = new Database(settings)
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  database.prepare('INSERT INTO app_settings VALUES (?,?)').run('fixture', 'snapshot settings')
  database.close()
  const target = path.join(directory, 'backup.zip')
  const adapter: ExportAdapter = {
    edition: 'community', root: () => source, version: () => 'fixture', deviceId: () => 'fixture',
    closeDatabases: async () => {}, validate: () => {}, verifyPayload: validateBackupArchive,
    collect: async () => [{ category: 'basicData', sourcePath: settings, archivePath: 'settings.db' }],
    treeDigest: exportTreeDigest, verifySources: verifyQuiescentSnapshot,
    writeStrict: writeStrictArchive, writeLive: writePartialArchive,
  }
  return { directory, source, settings, target, adapter }
}

describe('snapshot recovery boundaries', () => {
  it('marks a selected file removed between inventory and reading as recoverable', async () => {
    const entry = fixture()
    entry.adapter.hooks = { afterInventory: () => fs.unlinkSync(entry.settings) }
    const result = await exportBackup(entry.adapter, entry.target, options)
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(true)
    expect(fs.existsSync(entry.target)).toBe(false)
  })

  it('marks source disappearance during verification as recoverable', async () => {
    const entry = fixture()
    entry.adapter.verifySources = (...args) => { fs.unlinkSync(entry.settings); verifyQuiescentSnapshot(...args) }
    const result = await exportBackup(entry.adapter, entry.target, options)
    expect(result.retryable).toBe(true)
    expect(fs.existsSync(entry.target)).toBe(false)
  })

  it('recaptures a changed source when the intermediate payload cannot be validated', async () => {
    const entry = fixture()
    entry.adapter.validateSnapshot = () => { fs.writeFileSync(entry.settings, 'concurrent save'); throw new Error('Intermediate database is inconsistent') }
    const result = await exportBackup(entry.adapter, entry.target, options)
    expect(result.retryable).toBe(true)
    expect(fs.readFileSync(entry.settings, 'utf8')).toBe('concurrent save')
  })

  it('does not restart for a destination access failure', async () => {
    const entry = fixture()
    const result = await exportBackup(entry.adapter, path.join(entry.target, 'missing-directory', 'backup.zip'), options)
    expect(result.success).toBe(false)
    expect(result.retryable).toBeUndefined()
  })

  it('does not mistake stable corrupt data for a concurrent writer', async () => {
    const entry = fixture()
    entry.adapter.validateSnapshot = () => { throw new Error('Stored database is corrupt') }
    const result = await exportBackup(entry.adapter, entry.target, options)
    expect(result.success).toBe(false)
    expect(result.retryable).toBeUndefined()
  })

  it.each([false, true])('retains an existing destination when saved bytes fail validation, encrypted=%s', async encrypted => {
    const entry = fixture()
    await exportBackup(entry.adapter, entry.target, options)
    const zip = new AdmZip(entry.target)
    fs.writeFileSync(entry.target, 'previous backup')
    const corruptWriter = (_source: string, target: string) => fs.writeFileSync(target, 'corrupt output')
    if (!encrypted) vi.spyOn(zip, 'writeZip').mockImplementation(target => fs.writeFileSync(target!, 'corrupt output'))
    expect(() => writePartialArchive(entry.target, zip, encrypted ? { password: 'fixture-secret' } : undefined, 'fixture', corruptWriter)).toThrow()
    expect(fs.readFileSync(entry.target, 'utf8')).toBe('previous backup')
    expect(fs.readdirSync(entry.directory).sort()).toEqual(['backup.zip', 'source'])
  })
})
