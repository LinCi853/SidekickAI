import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { importAllData } from './import.js'
import { setImportingData } from '../import-guard.js'
import { applyPendingRestore, finishPendingRestore } from '../../../packages/backup-core/transaction.js'

const fixture = vi.hoisted(() => ({ root: '', release: vi.fn(), resume: vi.fn() }))
vi.mock('electron', () => ({ app: { relaunch: vi.fn(() => { throw new Error('Restart unavailable') }), exit: vi.fn() } }))
vi.mock('../../edition-runtime.js', () => ({ prepareDataRestoreHandoff: async () => fixture.release }))
vi.mock('./paths.js', () => ({ getDataDir: () => fixture.root }))
vi.mock('../../utils/file-crypto.js', () => ({ isSabkEncrypted: () => false }))
vi.mock('./transfer-adapter.js', () => ({ importAdapter: () => ({ edition: 'community', defaults: { profile: {}, presets: [] }, validateFull: () => {} }) }))
vi.mock('../../../packages/backup-core/import.js', () => ({ inspectBackup: vi.fn(), readImportBackup: async (_adapter: unknown, _file: string, staged: string) => {
  fs.writeFileSync(path.join(staged, 'settings.db'), 'incoming')
  return { manifest: { deviceId: 'fixture' }, decision: { mode: 'full' }, fingerprint: 'a'.repeat(64), report: { imported: [], skipped: [], warnings: [] } }
} }))

let temporary = ''
beforeEach(() => {
  vi.clearAllMocks(); setImportingData(false)
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cancellation-')); fixture.root = path.join(temporary, 'profile')
  fs.mkdirSync(fixture.root); fs.writeFileSync(path.join(fixture.root, 'settings.db'), 'original')
  fs.writeFileSync(path.join(temporary, 'archive.zip'), 'fixture archive')
})
afterEach(() => { vi.restoreAllMocks(); setImportingData(false); fs.rmSync(temporary, { recursive: true, force: true }) })
describe('restore cancellation', () => {
  it('retains a usable request and staging when cancellation fails', async () => {
    const current = fs.readFileSync(path.join(fixture.root, 'settings.db'), 'utf8')
    const request = `${fixture.root}.restore.json`
    const remove = fs.rmSync.bind(fs)
    const blocked = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === request) throw Object.assign(new Error('Request is locked'), { code: 'EACCES' })
      return remove(target, options)
    })
    const result = await importAllData(path.join(temporary, 'archive.zip'))
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('暂存与请求已保留') })
    const pending = JSON.parse(fs.readFileSync(request, 'utf8')), staged = `${fixture.root}.restore-${pending.token}`
    expect(fs.existsSync(path.join(staged, 'settings.db'))).toBe(true)
    expect(fs.readFileSync(path.join(fixture.root, 'settings.db'), 'utf8')).toBe(current)
    expect(fixture.release).toHaveBeenCalledOnce()
    blocked.mockRestore()
    expect(applyPendingRestore(fixture.root).restored).toBe(true)
    expect(fs.readFileSync(path.join(fixture.root, 'settings.db'), 'utf8')).toBe('incoming')
    finishPendingRestore(fixture.root)
  })
  it('removes staging only after cancellation succeeds', async () => {
    const current = fs.readFileSync(path.join(fixture.root, 'settings.db'), 'utf8')
    const result = await importAllData(path.join(temporary, 'archive.zip'))
    expect(result).toMatchObject({ success: false, error: 'Restart unavailable' })
    expect(fs.existsSync(`${fixture.root}.restore.json`)).toBe(false)
    expect(fs.readdirSync(temporary, { withFileTypes: true }).some(entry => entry.isDirectory() && entry.name.startsWith('profile.restore-'))).toBe(false)
    expect(fs.readFileSync(path.join(fixture.root, 'settings.db'), 'utf8')).toBe(current)
    expect(fixture.release).toHaveBeenCalledOnce()
  })
})
