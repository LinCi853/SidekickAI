import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  return {
    handlers,
    ipcMain: {
      on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) => {
        handlers.set(channel, handler)
      },
    },
  }
})
vi.mock('electron', () => ({ ipcMain: electron.ipcMain }))

type FocusModule = typeof import('./webview-focus.js')
let focus: FocusModule

function fire(editable: boolean): { sender: object; returnValue: unknown } {
  const event = { sender: {}, returnValue: undefined as unknown }
  electron.handlers.get(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE)?.(event, editable)
  return event
}

beforeEach(async () => {
  vi.resetModules()
  electron.handlers.clear()
  focus = await import('./webview-focus.js')
})

describe('webview focus tracking', () => {
  it('replies to sendSync so the guest renderer never blocks', () => {
    focus.installWebviewFocusTracking()
    expect(fire(true).returnValue).toBe(true)
  })

  it('caches the editable flag per sender webContents', () => {
    focus.installWebviewFocusTracking()
    const a = { id: 1 }
    const b = { id: 2 }
    electron.handlers.get(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE)?.({ sender: a, returnValue: undefined }, true)
    electron.handlers.get(IPC_CHANNELS.WEBVIEW_FOCUS_EDITABLE)?.({ sender: b, returnValue: undefined }, false)
    expect(focus.isGuestFocusEditable(a as never)).toBe(true)
    expect(focus.isGuestFocusEditable(b as never)).toBe(false)
    // 从未上报的 webContents 视为否
    expect(focus.isGuestFocusEditable({ id: 3 } as never)).toBe(false)
  })

  it('is idempotent and keeps answering after repeated install', () => {
    focus.installWebviewFocusTracking()
    focus.installWebviewFocusTracking()
    expect(fire(false).returnValue).toBe(true)
  })
})
