import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const state = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  sent: [] as Array<{ id: number; channel: string; payload: unknown }>,
  nativeDialog: vi.fn(),
  remember: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Function) => state.handlers.set(channel, handler),
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: state.nativeDialog },
}))
vi.mock('./download-settings.js', () => ({
  rememberDownloadDefault: state.remember,
}))
import { registerSaveDialogIpc, showSaveDialog } from './save-dialog.js'
import { IPC_CHANNELS } from '../shared/types.js'
import type { SaveDialogRequest } from '../shared/save-dialog.types.js'

function windowFixture(id: number) {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: {
      id,
      send: (channel: string, payload: unknown) => state.sent.push({ id, channel, payload }),
    },
  }
}

function lastRequest(): SaveDialogRequest {
  const entry = state.sent.find((s) => s.channel === IPC_CHANNELS.SAVE_DIALOG_REQUEST)
  if (!entry) throw new Error('no save request was sent')
  return entry.payload as SaveDialogRequest
}

beforeEach(() => {
  vi.resetAllMocks()
  state.handlers.clear()
  state.sent.length = 0
  state.nativeDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  registerSaveDialogIpc()
})

describe('in-app save dialog', () => {
  it('asks the initiating window and returns the chosen path', async () => {
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_HOST_READY)!(
      { sender: { id: 7, once: vi.fn() } },
      {},
    )
    const win = windowFixture(7)
    const pending = showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    const request = lastRequest()
    expect(request.title).toBe('另存为')
    expect(request.fileName).toBe('report.txt')
    expect(request.directory).toBe('E:/downloads')

    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 7, once: vi.fn() } },
      request.requestId,
      { action: 'save', fileName: 'report.txt', directory: 'E:/downloads' },
    )
    const outcome = await pending
    expect(outcome.action).toBe('save')
    expect(outcome.filePath).toBe(path.join('E:/downloads', 'report.txt'))
    expect(outcome.remember).toBe(false)
    expect(state.nativeDialog).not.toHaveBeenCalled()
  })

  it('reports the remember choice to the caller instead of writing settings itself', async () => {
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_HOST_READY)!(
      { sender: { id: 7, once: vi.fn() } },
      {},
    )
    const win = windowFixture(7)
    const pending = showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    const request = lastRequest()
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 7, once: vi.fn() } },
      request.requestId,
      {
        action: 'save',
        fileName: 'report.txt',
        directory: 'E:/chosen',
        remember: true,
      },
    )
    const outcome = await pending
    expect(outcome.remember).toBe(true)
    expect(state.remember).not.toHaveBeenCalled()
  })

  it('keeps the target inside the chosen directory', async () => {
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_HOST_READY)!(
      { sender: { id: 7, once: vi.fn() } },
      {},
    )
    const win = windowFixture(7)
    const pending = showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    const request = lastRequest()
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 7, once: vi.fn() } },
      request.requestId,
      { action: 'save', fileName: '../../escape.txt', directory: 'E:/downloads' },
    )
    const outcome = await pending
    expect(path.dirname(outcome.filePath!)).toBe(path.resolve('E:/downloads'))
  })

  it('reports a cancel without writing any file', async () => {
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_HOST_READY)!(
      { sender: { id: 7, once: vi.fn() } },
      {},
    )
    const win = windowFixture(7)
    const pending = showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    const request = lastRequest()
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 7, once: vi.fn() } },
      request.requestId,
      { action: 'cancel' },
    )
    const outcome = await pending
    expect(outcome).toEqual({ action: 'cancel', remember: false })
    expect(state.remember).not.toHaveBeenCalled()
  })

  it('ignores a reply coming from another window', async () => {
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_HOST_READY)!(
      { sender: { id: 7, once: vi.fn() } },
      {},
    )
    const win = windowFixture(7)
    const pending = showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    const request = lastRequest()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 99, once: vi.fn() } },
      request.requestId,
      { action: 'save', fileName: 'other.txt', directory: 'E:/other' },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    await state.handlers.get(IPC_CHANNELS.SAVE_DIALOG_RESULT)!(
      { sender: { id: 7, once: vi.fn() } },
      request.requestId,
      { action: 'save', fileName: 'report.txt', directory: 'E:/downloads' },
    )
    const outcome = await pending
    expect(outcome.filePath).toBe(path.join('E:/downloads', 'report.txt'))
  })

  it('falls back to the system dialog when the window has no in-app dialog', async () => {
    state.nativeDialog.mockResolvedValue({
      canceled: false,
      filePath: 'E:/chosen/report.txt',
    })
    const win = windowFixture(9)
    const outcome = await showSaveDialog(win as unknown as BrowserWindow, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    expect(state.nativeDialog).toHaveBeenCalledTimes(1)
    expect(outcome.filePath).toBe('E:/chosen/report.txt')
  })

  it('falls back to the system dialog when there is no window at all', async () => {
    state.nativeDialog.mockResolvedValue({
      canceled: false,
      filePath: 'E:/chosen/report.txt',
    })
    const outcome = await showSaveDialog(null, {
      title: '另存为',
      fileName: 'report.txt',
      directory: 'E:/downloads',
    })
    expect(state.nativeDialog).toHaveBeenCalledTimes(1)
    expect(outcome.filePath).toBe('E:/chosen/report.txt')
  })
})
