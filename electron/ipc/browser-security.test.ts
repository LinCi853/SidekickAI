import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), temporary: '', destination: undefined as string | undefined,
  openExternal: vi.fn(), showSave: vi.fn(), guest: undefined as any }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) },
  shell: { openExternal: state.openExternal }, app: { getPath: () => state.temporary }, protocol: {},
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) }, dialog: { showSaveDialogSync: state.showSave }, screen: {} }))
vi.mock('../store/browser-window-store.js', () => ({ browserWindowStore: {} }))
vi.mock('../store/bookmark-store.js', () => ({ bookmarkStore: {} }))
vi.mock('../store/window-store.js', () => ({ windowStore: {}, MAIN_WINDOW_ID: 'main' }))
vi.mock('../window-state.js', () => ({ windowState: {} }))
vi.mock('../window-factory.js', () => ({ findWindowIdByWin: () => 'window-a' }))
vi.mock('../utils/cloud-pc.js', () => ({ enterCloudPc: vi.fn(), exitCloudPc: vi.fn() }))
vi.mock('../utils/fullscreen-tracker.js', () => ({ isTrackedFullscreen: () => false }))
vi.mock('../security/trusted-renderer.js', () => ({ assertTrustedRenderer: (event: any) => { if (!event.trusted) throw new Error('untrusted') } }))
vi.mock('../security/webview-owner.js', () => ({
  ownedWebContents: (event: any, id: unknown) => { if (!event.trusted || id !== state.guest.id) throw new Error('unowned'); return state.guest },
  ownedProfileSession: (event: any, partition: string) => { if (!event.trusted || partition !== 'persist:profile-a') throw new Error('unowned'); return {} },
}))
import { registerBrowserIpc } from './browser-ipc.js'
import { createPdfPreview, readPdfPreview } from '../utils/pdf-protocol.js'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'

let event: any
const invoke = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!(event, ...args)
beforeAll(() => { state.temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-security-')) })
afterAll(() => { fs.rmSync(state.temporary, { recursive: true, force: true }) })
beforeEach(() => {
  state.openExternal.mockReset(); state.showSave.mockReset(); state.handlers.clear()
  event = { trusted: true, sender: new EventEmitter() }
  state.guest = { id: 7, printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\nselected')) }
  registerBrowserIpc({ createBrowserWindow: vi.fn() })
})
afterEach(() => { event.sender.emit('destroyed') })

it('opens only validated web links from the trusted host', async () => {
  for (const value of ['file:///C:/Windows/calc.exe', 'ms-settings:display', 'https://user:password@example.com/', null]) {
    expect(() => invoke(ipc.BROWSER_OPEN_EXTERNAL, value)).toThrow()
  }
  event.trusted = false
  expect(() => invoke(ipc.BROWSER_OPEN_EXTERNAL, 'https://example.com/')).toThrow()
  expect(state.openExternal).not.toHaveBeenCalled()
  event.trusted = true
  await invoke(ipc.BROWSER_OPEN_EXTERNAL, 'https://example.com/path')
  expect(state.openExternal).toHaveBeenCalledWith('https://example.com/path')
})

it('refuses raw PDF paths for save and delete without touching unrelated bytes', () => {
  const file = path.join(state.temporary, 'sidekick-print-unrelated.pdf')
  fs.writeFileSync(file, 'unrelated')
  expect(invoke(ipc.BROWSER_SAVE_PDF_AS, file)).toMatchObject({ ok: false })
  expect(invoke(ipc.BROWSER_DELETE_TEMP_PDF, file)).toEqual({ ok: false })
  expect(state.showSave).not.toHaveBeenCalled()
  expect(fs.readFileSync(file, 'utf8')).toBe('unrelated')
})

it('creates, saves and deletes a registered PDF using native destination selection', async () => {
  const result = await invoke(ipc.BROWSER_PRINT_PREVIEW, 7, 'Title')
  expect(result.ok).toBe(true)
  expect(path.isAbsolute(result.filePath)).toBe(false)
  const bytes = readPdfPreview(result.filePath, event.sender)
  const target = path.join(state.temporary, 'saved.pdf')
  fs.writeFileSync(target, 'an older longer file whose tail must be removed')
  state.showSave.mockReturnValue(target)
  expect(invoke(ipc.BROWSER_SAVE_PDF_AS, result.filePath, 'Title')).toEqual({ ok: true })
  expect(fs.readFileSync(target)).toEqual(bytes)
  expect(invoke(ipc.BROWSER_DELETE_TEMP_PDF, result.filePath)).toEqual({ ok: true })
  expect(() => readPdfPreview(result.filePath, event.sender)).toThrow()
})

it('binds previews and source reads to their caller and excludes local URL schemes', async () => {
  const other = new EventEmitter()
  const token = createPdfPreview(Buffer.from('%PDF-other'), other as any)
  expect(invoke(ipc.BROWSER_SAVE_PDF_AS, token)).toMatchObject({ ok: false })
  expect(invoke(ipc.BROWSER_DELETE_TEMP_PDF, token)).toEqual({ ok: false })
  other.emit('destroyed')
  expect((await invoke(ipc.BROWSER_PRINT_PREVIEW, 8)).ok).toBe(false)
  expect((await invoke(ipc.BROWSER_VIEW_SOURCE, 'persist:other', 'https://example.com')).ok).toBe(false)
  for (const url of ['file:///C:/unrelated', 'data:text/plain,unrelated']) {
    expect((await invoke(ipc.BROWSER_VIEW_SOURCE, 'persist:profile-a', url)).ok).toBe(false)
  }
})
