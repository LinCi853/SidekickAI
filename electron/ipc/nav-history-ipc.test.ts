import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({ directory: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'exe' ? path.join(fixture.directory, 'app.exe') : fixture.directory },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => fixture.handlers.set(name, handler) },
}))

let store: typeof import('../store/nav-history-store.js')
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-navigation-'))
  fixture.handlers.clear()
  store = await import('../store/nav-history-store.js')
})
afterEach(() => {
  store.closeNavHistoryStore()
  fs.rmSync(fixture.directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('main-window navigation history', () => {
  it('records and reads history without registering optional browser IPC', async () => {
    const { registerNavHistoryIpc } = await import('./nav-history-ipc.js')
    const { IPC_CHANNELS } = await import('../shared/ipc-channels.js')
    registerNavHistoryIpc()
    const record = fixture.handlers.get(IPC_CHANNELS.NAV_HISTORY_RECORD)
    const get = fixture.handlers.get(IPC_CHANNELS.NAV_HISTORY_GET)
    expect(record).toBeTypeOf('function')
    record!(null, 'fixture-profile', { id: 'fixture-entry', profileId: 'fixture-profile', url: 'https://example.invalid/record', title: 'Saved history', timestamp: 1 })
    expect(get!(null, 'fixture-profile')).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Saved history' })]))
  })
})
