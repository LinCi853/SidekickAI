import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { classifyBackup } from './compatibility.js'
import { readImportBackup } from './import.js'
import { composeIncludedRestore, composeLimitedRestore, validateSettingsDatabase, validateTransfer } from './transfer.js'
import { applyPendingRestore, finishPendingRestore, prepareRestoreDirectory, queuePreparedRestore, requestRestoreRollback } from './transaction.js'
import type { BackupManifest } from './types.js'

let temporary = ''
const options = { basicData: true, cookies: true, indexedDB: true, cache: true }
const manifest = (extra: Partial<BackupManifest> = {}): BackupManifest => ({ format: 'sidekickai-backup', formatVersion: 1, deviceId: 'fixture', appVersion: '0.1.5', exportedAt: '', edition: 'community', dataSchemaVersion: 1, entries: {}, options, ...extra })
const preset = { id: 'desktop', name: 'Desktop', platform: 'desktop', userAgent: 'fixture', viewport: { width: 1000, height: 800 }, devicePixelRatio: 1 }
const profile = { ...preset, id: 'account', isAIPlatform: true, aiPlatformUrl: 'https://example.test' }
const defaults = { profile, presets: [preset] }
function write(root: string, name: string, bytes: string) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), bytes) }
function seed(root: string, marker: string, providers?: unknown[]) {
  fs.mkdirSync(root, { recursive: true })
  const db = new Database(path.join(root, 'settings.db'))
  try {
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    db.prepare('INSERT INTO app_settings VALUES (?,?)').run('marker', marker)
    if (providers) { db.exec('CREATE TABLE ai_providers (key TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT INTO ai_providers VALUES (?,?)').run('__data__', JSON.stringify({ providers })) }
  } finally { db.close() }
}
function marker(root: string) { const db = new Database(path.join(root, 'settings.db')); try { return (db.prepare('SELECT value FROM app_settings WHERE key=?').get('marker') as { value: string }).value } finally { db.close() } }
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'import-choices-')) })
afterEach(() => { fs.rmSync(temporary, { recursive: true, force: true }) })

describe('automatic import', () => {
  it('automatically reports separable invalid configurations during cross-edition archive inspection', async () => {
    const source = path.join(temporary, 'source')
    seed(source, 'incoming', [{ id: 'broken', name: 'Broken', protocol: 'openai', model: 'fixture', apiEndpoint: 'file:///invalid', apiKeyCipher: '' }])
    const bytes = fs.readFileSync(path.join(source, 'settings.db')), zip = new AdmZip()
    zip.addFile('settings.db', bytes)
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({ edition: 'concept', entries: { 'settings.db': createHash('sha256').update(bytes).digest('hex') } }))))
    const file = path.join(temporary, 'automatic.zip'); zip.writeZip(file)
    const staged = path.join(temporary, 'staged'); fs.mkdirSync(staged)
    const result = await readImportBackup({ edition: 'community', defaults, validateFull: () => { throw new Error('Unexpected complete restore') } }, file, staged)
    expect(result.decision.mode).toBe('limited')
    expect(result.report.skipped).toEqual([{ category: 'providers', id: 'broken', reason: expect.any(String) }])
    expect(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')).importReport.skipped).toHaveLength(1)
  })
  it('restores included login material and checks every archive entry', async () => {
    const source = path.join(temporary, 'source'); seed(source, 'incoming')
    const zip = new AdmZip(), entries: Record<string, string> = {}
    for (const [name, bytes] of [['settings.db', fs.readFileSync(path.join(source, 'settings.db'))], ['Local State', Buffer.from('source identity')], ['Partitions/account/Network/Cookies', Buffer.from('source login')], ['Partitions/account/Local Storage/leveldb/data', Buffer.from('source local storage')], ['Partitions/account/IndexedDB/data', Buffer.from('source indexed')]] as const) {
      zip.addFile(name, bytes); entries[name] = createHash('sha256').update(bytes).digest('hex')
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest({ entries }))))
    const file = path.join(temporary, 'backup.zip'); zip.writeZip(file)
    const staged = path.join(temporary, 'selected'); fs.mkdirSync(staged)
    const adapter = { edition: 'community' as const, defaults, validateFull: (directory: string) => validateSettingsDatabase(path.join(directory, 'settings.db')) }
    const prepared = await readImportBackup(adapter, file, staged, undefined, undefined)
    expect(prepared.decision.mode).toBe('full')
    expect(prepared.report.skipped).toEqual([])
    expect(fs.existsSync(path.join(staged, 'Local State'))).toBe(true)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Network/Cookies'))).toBe(true)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Local Storage'))).toBe(true)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/IndexedDB/data'))).toBe(true)
    zip.updateFile('Partitions/account/Network/Cookies', Buffer.from('corrupt excluded material')); zip.writeZip(file)
    const invalid = path.join(temporary, 'invalid'); fs.mkdirSync(invalid)
    await expect(readImportBackup(adapter, file, invalid, undefined, undefined)).rejects.toThrow(/integrity/)
  })
  it('chooses a supported restore automatically and rejects future structure', () => {
    expect(classifyBackup(manifest(), 'community').mode).toBe('full')
    expect(classifyBackup(manifest({ dataSchemaVersion: undefined }), 'community').mode).toBe('limited')
    expect(classifyBackup(manifest({ edition: 'concept' }), 'community').mode).toBe('limited')
    expect(() => classifyBackup(manifest({ dataSchemaVersion: 2 }), 'community')).toThrow(/数据结构/)
  })
  it('preserves omitted session categories and target encryption identity', () => {
    const root = path.join(temporary, 'root'), staged = path.join(temporary, 'staged')
    seed(root, 'old'); seed(staged, 'new')
    write(root, 'Local State', 'target identity'); write(root, 'Partitions/account/Network/Cookies', 'target login')
    write(root, 'Partitions/account/Network/Network Persistent State', 'target network')
    write(root, 'Partitions/account/Local Storage/leveldb/old', 'target storage')
    write(root, 'Partitions/account/Cache/cache', 'target cache')
    write(root, 'Partitions/account/IndexedDB/old', 'obsolete indexed')
    write(staged, 'Partitions/account/IndexedDB/new', 'incoming indexed')
    write(staged, 'manifest.json', JSON.stringify(manifest({ options: { ...options, cookies: false, cache: false } })))
    composeIncludedRestore(root, staged)
    expect(fs.readFileSync(path.join(staged, 'Local State'), 'utf8')).toBe('target identity')
    expect(fs.readFileSync(path.join(staged, 'Partitions/account/Network/Cookies'), 'utf8')).toBe('target login')
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Local Storage/leveldb/old'))).toBe(true)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Cache/cache'))).toBe(true)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/IndexedDB/old'))).toBe(false)
  })
  it('drops old raw cookies when a portable snapshot replaces them but retains unrelated network data', () => {
    const root = path.join(temporary, 'root'), staged = path.join(temporary, 'staged')
    seed(root, 'old'); seed(staged, 'new')
    write(root, 'Partitions/account/Network/Cookies', 'old'); write(root, 'Partitions/account/Network/Cookies-wal', 'old')
    write(root, 'Partitions/account/Network/Network Persistent State', 'network')
    write(staged, 'manifest.json', JSON.stringify(manifest({ cookieSnapshots: [{ path: 'Partitions/account', cookies: [] }] })))
    composeIncludedRestore(root, staged)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Network/Cookies'))).toBe(false)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Network/Cookies-wal'))).toBe(false)
    expect(fs.existsSync(path.join(staged, 'Partitions/account/Network/Network Persistent State'))).toBe(true)
  })
  it('automatically skips isolated invalid records and preserves the target entry', () => {
    const root = path.join(temporary, 'root'), staged = path.join(temporary, 'staged')
    const good = { id: 'good', name: 'Good', protocol: 'openai', model: 'fixture', apiEndpoint: 'https://example.test', apiKeyCipher: '' }
    seed(root, 'old', [{ ...good, id: 'bad', name: 'Keep' }]); seed(staged, 'new', [good, { ...good, id: 'bad', apiEndpoint: 'file:///private' }])
    expect(validateTransfer(staged, defaults)).toMatchObject({ imported: [{ category: 'providers', id: 'good' }], skipped: [{ category: 'providers', id: 'bad' }] })
    write(staged, 'manifest.json', JSON.stringify(manifest({ sensitiveDrafts: { version: 1, entries: [] } })))
    composeLimitedRestore(root, staged, 'community', defaults)
    const db = new Database(path.join(staged, 'settings.db'))
    try { const row = db.prepare('SELECT value FROM ai_providers').get() as { value: string }; expect(JSON.parse(row.value).providers.map((item: any) => item.name)).toEqual(['Keep', 'Good']) } finally { db.close() }
    expect(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')).sensitiveDrafts).toBeUndefined()
    fs.writeFileSync(path.join(staged, 'settings.db'), 'broken')
    expect(() => validateTransfer(staged, defaults)).toThrow()
  })
})

describe('temporary restore transactions', () => {
  function prepared() {
    const root = path.join(temporary, 'profile'); seed(root, 'original')
    const staged = prepareRestoreDirectory(root); seed(staged, 'incoming')
    queuePreparedRestore(root, staged)
    const request = JSON.parse(fs.readFileSync(`${root}.restore.json`, 'utf8'))
    return { root, staged, backup: `${root}.bak-${request.token}`, failed: `${root}.failed-${request.token}` }
  }
  it('removes only this transaction backup and metadata after success', () => {
    const { root, staged, backup } = prepared()
    const unrelated = `${root}.bak-unregistered`; write(unrelated, 'keep', 'unrelated')
    expect(applyPendingRestore(root).restored).toBe(true)
    finishPendingRestore(root)
    expect(marker(root)).toBe('incoming')
    expect(fs.existsSync(backup)).toBe(false); expect(fs.existsSync(staged)).toBe(false)
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
    expect(fs.existsSync(`${root}.restore-candidates.json`)).toBe(false)
    expect(fs.readFileSync(path.join(unrelated, 'keep'), 'utf8')).toBe('unrelated')
  })
  it('automatically rolls back and deletes this failed input after finalization fails', () => {
    const { root, staged, backup, failed } = prepared()
    expect(applyPendingRestore(root).restored).toBe(true)
    write(root, 'partially-replayed', 'private input')
    requestRestoreRollback(root)
    expect(applyPendingRestore(root)).toMatchObject({ restored: false, error: expect.any(String) })
    expect(marker(root)).toBe('original')
    for (const target of [staged, backup, failed, `${root}.restore.json`]) expect(fs.existsSync(target)).toBe(false)
  })
  it('does not reverse committed data when backup cleanup temporarily fails', () => {
    const { root, backup } = prepared()
    applyPendingRestore(root)
    const remove = fs.rmSync.bind(fs)
    const blocked = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === backup) throw new Error('Temporary directory lock')
      return remove(target, options)
    })
    try { expect(() => finishPendingRestore(root)).not.toThrow() } finally { blocked.mockRestore() }
    expect(marker(root)).toBe('incoming')
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
    expect(() => requestRestoreRollback(root)).toThrow(/current state/)
    expect(applyPendingRestore(root)).toEqual({ restored: false })
    expect(marker(root)).toBe('incoming'); expect(fs.existsSync(backup)).toBe(true)
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
  })
  it('does not repeat a successful rollback when failed-input cleanup temporarily fails', () => {
    const { root, failed } = prepared()
    applyPendingRestore(root); requestRestoreRollback(root)
    const remove = fs.rmSync.bind(fs)
    const blocked = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === failed) throw new Error('Temporary directory lock')
      return remove(target, options)
    })
    try { expect(applyPendingRestore(root).restored).toBe(false) } finally { blocked.mockRestore() }
    expect(marker(root)).toBe('original')
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
    expect(applyPendingRestore(root)).toEqual({ restored: false })
    expect(marker(root)).toBe('original'); expect(fs.existsSync(failed)).toBe(true)
  })
  it.each(['committed', 'rolled-back'])('allows another import after partial cleanup of a %s transaction', state => {
    const { root, backup, failed } = prepared()
    applyPendingRestore(root)
    if (state === 'rolled-back') requestRestoreRollback(root)
    const targetDirectory = state === 'committed' ? backup : failed
    const remove = fs.rmSync.bind(fs)
    const blocked = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === targetDirectory) {
        remove(path.join(targetDirectory, 'settings.db'), { force: true })
        throw Object.assign(new Error('Temporary directory lock after partial deletion'), { code: 'EBUSY' })
      }
      return remove(target, options)
    })
    try {
      if (state === 'committed') expect(() => finishPendingRestore(root)).not.toThrow()
      else expect(applyPendingRestore(root).restored).toBe(false)
    } finally { blocked.mockRestore() }
    expect(marker(root)).toBe(state === 'committed' ? 'incoming' : 'original')
    expect(fs.existsSync(targetDirectory)).toBe(true)
    expect(fs.existsSync(path.join(targetDirectory, 'settings.db'))).toBe(false)
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
    expect(applyPendingRestore(root)).toEqual({ restored: false })
    const next = prepareRestoreDirectory(root); seed(next, 'next')
    expect(() => queuePreparedRestore(root, next)).not.toThrow()
    expect(applyPendingRestore(root).restored).toBe(true)
    finishPendingRestore(root)
    expect(marker(root)).toBe('next')
    expect(fs.existsSync(targetDirectory)).toBe(true)
  })
  it.each(['modified', 'replaced', 'junction'])('preserves both trees when the rollback source is %s', kind => {
    const { root, backup } = prepared()
    applyPendingRestore(root)
    if (kind === 'modified') write(backup, 'unexpected', 'changed')
    else {
      const preserved = path.join(temporary, 'preserved'); fs.renameSync(backup, preserved)
      if (kind === 'junction') fs.symlinkSync(preserved, backup, process.platform === 'win32' ? 'junction' : 'dir')
      else fs.cpSync(preserved, backup, { recursive: true })
    }
    requestRestoreRollback(root)
    expect(() => applyPendingRestore(root)).toThrow(/identity|integrity|symbolic link|junction/)
    expect(marker(root)).toBe('incoming'); expect(fs.existsSync(backup)).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${root}.restore.json`, 'utf8')).state).toBe('rollback')
  })
  it('preserves a backup that changed before cleanup and keeps the committed current data', () => {
    const { root, backup } = prepared()
    applyPendingRestore(root); write(backup, 'external', 'unrecognized edit')
    expect(() => finishPendingRestore(root)).not.toThrow()
    expect(marker(root)).toBe('incoming')
    expect(fs.readFileSync(path.join(backup, 'external'), 'utf8')).toBe('unrecognized edit')
    expect(fs.existsSync(`${root}.restore.json`)).toBe(false)
    expect(() => prepareRestoreDirectory(root)).not.toThrow()
  })
  it('retains the completed request if the active data identity changes during cleanup', () => {
    const { root, backup } = prepared()
    applyPendingRestore(root)
    const preserved = path.join(temporary, 'installed')
    const remove = fs.rmSync.bind(fs)
    const changed = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === backup) {
        fs.renameSync(root, preserved)
        seed(root, 'unrelated')
        throw new Error('Application data identity changed')
      }
      return remove(target, options)
    })
    try { expect(() => finishPendingRestore(root)).not.toThrow() } finally { changed.mockRestore() }
    expect(marker(root)).toBe('unrelated'); expect(marker(preserved)).toBe('incoming')
    expect(JSON.parse(fs.readFileSync(`${root}.restore.json`, 'utf8')).state).toBe('committed')
    expect(fs.existsSync(backup)).toBe(true)
  })
  it('refuses changed staged or installed directory identities without deleting replacements', () => {
    const { root, staged } = prepared()
    const preserved = path.join(temporary, 'validated'); fs.renameSync(staged, preserved); seed(staged, 'unrelated')
    expect(applyPendingRestore(root).restored).toBe(false)
    expect(marker(root)).toBe('original'); expect(marker(staged)).toBe('unrelated'); expect(marker(preserved)).toBe('incoming')
  })
})
