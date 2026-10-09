import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'

const runtime = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), save: vi.fn(), open: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => runtime.handlers.set(channel, handler) }, dialog: { showSaveDialog: runtime.save, showOpenDialog: runtime.open }, safeStorage: {} }))
vi.mock('../security/trusted-renderer.js', () => ({ assertTrustedRenderer: (event: any) => { if (!event?.trusted) throw new Error('Untrusted renderer') } }))
vi.mock('./module-state-store.js', () => ({ createSqliteJsonStore: () => ({ get: () => [], set() {} }) }))
vi.mock('../utils/permission-manager.js', () => ({ isSafeStorageAvailable: () => false, xorDecrypt: () => { throw new Error('Legacy credential') } }))
vi.mock('../utils/app-crypto.js', () => ({ encryptString: (value: string) => value, decryptString: () => '', isAesEncrypted: () => false, encryptWithPassword: () => '', decryptWithPassword: () => '' }))
import { registerAIProviderIPC } from './ai-provider-store.js'

let root: string
let event: any
const invoke = (channel: string, ...args: unknown[]) => runtime.handlers.get(channel)!(event, ...args)
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-files-'))
  event = { trusted: true, sender: new EventEmitter(), senderFrame: {} }
  event.sender.mainFrame = event.senderFrame
  runtime.handlers.clear(); runtime.save.mockReset(); runtime.open.mockReset()
  registerAIProviderIPC()
})
afterEach(() => { event.sender.emit('destroyed'); fs.rmSync(root, { recursive: true, force: true }) })

it('rejects arbitrary path reads and writes without touching their bytes', async () => {
  const file = path.join(root, 'unselected.txt'); fs.writeFileSync(file, 'unrelated')
  expect(await invoke(ipc.AI_PROVIDER_READ_IMPORT_FILE, file)).toMatchObject({ ok: false })
  expect(await invoke(ipc.AI_PROVIDER_WRITE_EXPORT_FILE, file, 'replacement')).toMatchObject({ ok: false })
  expect(fs.readFileSync(file, 'utf8')).toBe('unrelated')
})

it('reads a selected import once and does not reopen a replaced path', async () => {
  const file = path.join(root, 'selected.sapp'); fs.writeFileSync(file, 'selected contents')
  runtime.open.mockResolvedValue({ canceled: false, filePaths: [file] })
  const selected = await invoke(ipc.AI_PROVIDER_SELECT_IMPORT_FILE)
  expect(selected).toMatchObject({ name: 'selected.sapp', token: expect.any(String) })
  fs.renameSync(file, file + '.original'); fs.writeFileSync(file, 'replaced contents')
  expect(await invoke(ipc.AI_PROVIDER_READ_IMPORT_FILE, selected.token)).toMatchObject({ ok: true, content: 'selected contents' })
  expect(await invoke(ipc.AI_PROVIDER_READ_IMPORT_FILE, selected.token)).toMatchObject({ ok: false })
})

it('binds a save grant to its sender and consumes it after one write', async () => {
  const file = path.join(root, 'export.sapp'); fs.writeFileSync(file, 'old contents longer than new')
  runtime.save.mockResolvedValue({ canceled: false, filePath: file })
  const selected = await invoke(ipc.AI_PROVIDER_SELECT_EXPORT_PATH)
  const other = { trusted: true, sender: new EventEmitter(), senderFrame: {} }
  expect(await runtime.handlers.get(ipc.AI_PROVIDER_WRITE_EXPORT_FILE)!(other, selected.token, 'unowned')).toMatchObject({ ok: false })
  expect(fs.readFileSync(file, 'utf8')).toBe('old contents longer than new')
  expect(await invoke(ipc.AI_PROVIDER_WRITE_EXPORT_FILE, selected.token, 'new')).toEqual({ ok: true })
  expect(fs.readFileSync(file, 'utf8')).toBe('new')
  expect(await invoke(ipc.AI_PROVIDER_WRITE_EXPORT_FILE, selected.token, 'again')).toMatchObject({ ok: false })
})

it('does not create a grant when the dialog is cancelled', async () => {
  runtime.save.mockResolvedValue({ canceled: true })
  runtime.open.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await invoke(ipc.AI_PROVIDER_SELECT_EXPORT_PATH)).toBeNull()
  expect(await invoke(ipc.AI_PROVIDER_SELECT_IMPORT_FILE)).toBeNull()
})

it('requires a trusted application caller before showing either dialog', async () => {
  event.trusted = false
  await expect(invoke(ipc.AI_PROVIDER_SELECT_EXPORT_PATH)).rejects.toThrow('Untrusted')
  await expect(invoke(ipc.AI_PROVIDER_SELECT_IMPORT_FILE)).rejects.toThrow('Untrusted')
  expect(runtime.save).not.toHaveBeenCalled()
  expect(runtime.open).not.toHaveBeenCalled()
})
