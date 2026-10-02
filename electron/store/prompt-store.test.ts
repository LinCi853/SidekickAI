import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const runtime = vi.hoisted(() => ({ directory: '', send: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'exe' ? path.join(runtime.directory, 'app.exe') : runtime.directory },
  ipcMain: { handle: vi.fn() }, dialog: {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: runtime.send } }] },
}))
let settings: typeof import('./module-state-store')
let prompts: typeof import('./prompt-store')
beforeEach(async () => {
  vi.resetModules(); runtime.send.mockClear(); vi.stubEnv('ELECTRON_RENDERER_URL', '')
  runtime.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-change-'))
  settings = await import('./module-state-store'); prompts = await import('./prompt-store')
})
afterEach(() => { settings.closeModuleStateDb(); fs.rmSync(runtime.directory, { recursive: true, force: true }); vi.unstubAllEnvs() })
describe('prompt mutation notifications', () => {
  it('notifies all consumers for direct store writers and batches synchronous mutations', async () => {
    const a = prompts.promptStore.save({ id: '', title: 'Note template', content: 'Text', createdAt: 1, updatedAt: 1 })
    prompts.promptStore.save({ id: '', title: 'Other template', content: 'Other', createdAt: 1, updatedAt: 1 })
    prompts.promptStore.delete(a.id)
    await Promise.resolve()
    expect(runtime.send).toHaveBeenCalledTimes(1)
    expect(runtime.send).toHaveBeenCalledWith('prompt:changed', undefined)
    expect(prompts.promptStore.list()).toHaveLength(1)
  })
  it('does not refill user-cleared templates when the component is re-enabled', () => {
    settings.saveModuleState({ id: 'prompt-library', enabled: false, installed: true, clearedAt: 1, updatedAt: 1 })
    prompts.ensureDefaultPrompts()
    expect(prompts.promptStore.list()).toHaveLength(0)
  })
})
