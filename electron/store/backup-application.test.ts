import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ prepare: vi.fn(), run: vi.fn(), export: vi.fn() }))
vi.mock('../../packages/backup-core/recovery.js', () => ({ exportWithRecovery: mock.run, finishBackupRecovery: vi.fn() }))
vi.mock('../edition-runtime.js', () => ({ preparePermissionHandoff: mock.prepare, quitForBackup: vi.fn() }))
vi.mock('./backup/export.js', () => ({ exportAllData: mock.export }))
vi.mock('./backup/paths.js', () => ({ getDataDir: () => 'E:/isolated-source' }))
vi.mock('./backup-recovery-windows.js', () => ({ captureBackupWindows: vi.fn(), restoreBackupWindows: vi.fn() }))
import { exportApplicationData } from './backup-recovery.js'

beforeEach(() => { vi.clearAllMocks(); mock.prepare.mockResolvedValue(true); mock.run.mockResolvedValue({ success: true }) })
it('uses default staging and releases each application export after completion', async () => {
  const options = { basicData: true, cookies: true, indexedDB: true, cache: false }
  await expect(exportApplicationData('E:/backup.zip', options)).resolves.toEqual({ success: true })
  expect(mock.run).toHaveBeenCalledWith(expect.objectContaining({ export: mock.export }), 'E:/backup.zip', options, undefined, { cleanup: true })
})
it('does not create a backup task when current changes cannot be saved', async () => {
  mock.prepare.mockResolvedValue(false)
  expect((await exportApplicationData('E:/backup.zip', { basicData: true, cookies: false, indexedDB: false, cache: false })).success).toBe(false)
  expect(mock.run).not.toHaveBeenCalled()
})
