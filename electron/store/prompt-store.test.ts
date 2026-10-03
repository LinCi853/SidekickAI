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

describe('prompt examples', () => {
  it('round-trips a snapshot independently of its source and preserves extra fields when editing', () => {
    const template = prompts.promptStore.save({ id: 'example', title: 'Example', content: '', example: { content: 'Snapshot', conversationId: 'removed-conversation', messageId: 'removed-message' }, createdAt: 1, updatedAt: 1, custom: 'retained' } as never)
    prompts.promptStore.save({ ...template, title: 'Edited', example: { ...template.example!, content: 'Edited snapshot' } })
    const exported = prompts.promptStore.exportPrompts()
    prompts.promptStore.delete('example')
    expect(prompts.promptStore.importPrompts(exported)).toEqual({ added: 1, updated: 0 })
    expect(prompts.promptStore.list()[0]).toMatchObject({ title: 'Edited', content: '', example: { content: 'Edited snapshot', conversationId: 'removed-conversation', messageId: 'removed-message' }, custom: 'retained', createdAt: 1 })
  })

  it('imports old general templates and preserves existing legacy blank records', () => {
    expect(prompts.promptStore.importPrompts(JSON.stringify({ prompts: [
      { id: 'old', title: 'Old', content: 'General content', category: 'Archive', hotkey: 'Ctrl+1', createdAt: 1, updatedAt: 1 },
      { id: 'blank', title: 'Legacy blank', content: '' },
    ] }))).toEqual({ added: 2, updated: 0 })
    expect(JSON.parse(prompts.promptStore.exportPrompts()).prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'old', content: 'General content', category: 'Archive', hotkey: 'Ctrl+1' }),
      expect.objectContaining({ id: 'blank', content: '' }),
    ]))
    expect(() => prompts.promptStore.save({ id: '', title: 'Blank', content: ' ', createdAt: 1, updatedAt: 1 })).toThrow()
  })

  it('retains a saved example when a general-only writer edits the same template', () => {
    prompts.promptStore.save({ id: 'example', title: 'Original', content: 'General', example: { content: 'Saved case', conversationId: 'source' }, createdAt: 1, updatedAt: 1 })
    prompts.promptStore.save({ id: 'example', title: 'Edited', content: 'New general', createdAt: 7, updatedAt: 7 })
    expect(prompts.promptStore.list()[0]).toMatchObject({ title: 'Edited', content: 'New general', example: { content: 'Saved case', conversationId: 'source' }, createdAt: 1 })
  })

  it('refuses malformed imports before changing any stored template', () => {
    const old = prompts.promptStore.save({ id: 'old', title: 'Old', content: 'Original', createdAt: 1, updatedAt: 1 })
    const malformed = [
      { ...old, title: 7 },
      { ...old, example: { content: 7 } },
      { ...old, example: { content: 'Case', conversationId: 7 } },
      { ...old, example: { content: 'Case', messageId: 'missing-conversation' } },
      { ...old, hotkey: [] },
      { ...old, content: '', example: { content: '' } },
    ]
    for (const invalid of malformed) {
      expect(() => prompts.promptStore.importPrompts(JSON.stringify({ prompts: [{ ...old, content: 'Overwritten' }, invalid] }))).toThrow()
      expect(prompts.promptStore.list()).toEqual([old])
    }
    expect(() => prompts.promptStore.importPrompts('{"prompts":{}}')).toThrow()
  })
})
