import { beforeEach, expect, it, vi } from 'vitest'
import { hasActiveBackupOperations, runBackupOperation } from './activity'
import { setImportingData } from '../import-guard'

beforeEach(() => setImportingData(false))
it('rejects restore during export and rejects all competing operations during restore', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const exported = runBackupOperation('export', async () => { await pending; return { success: true } })
  const blocked = vi.fn(async () => ({ success: true }))
  expect((await runBackupOperation('restore', blocked)).success).toBe(false)
  expect(blocked).not.toHaveBeenCalled()
  finish(); await exported
  await runBackupOperation('restore', async () => {
    expect((await runBackupOperation('export', blocked)).success).toBe(false)
    expect((await runBackupOperation('restore', blocked)).success).toBe(false)
    return { success: false }
  })
  expect((await runBackupOperation('export', blocked)).success).toBe(true)
})
it('releases failed preparation but blocks changes after a restore has been queued', async () => {
  await expect(runBackupOperation('restore', async () => { throw new Error('Unavailable') })).rejects.toThrow('Unavailable')
  expect((await runBackupOperation('restore', async () => { setImportingData(true); return { success: true } })).success).toBe(true)
  const blocked = vi.fn()
  expect((await runBackupOperation('export', blocked)).success).toBe(false)
  expect(blocked).not.toHaveBeenCalled()
  setImportingData(false)
})
it('exposes activity throughout delayed restore preparation and releases failed attempts', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  expect(hasActiveBackupOperations()).toBe(false)
  const restore = runBackupOperation('restore', async () => { await pending; return { success: false } })
  expect(hasActiveBackupOperations()).toBe(true)
  finish(); await restore
  expect(hasActiveBackupOperations()).toBe(false)
  setImportingData(true); expect(hasActiveBackupOperations()).toBe(true)
  setImportingData(false)
})
