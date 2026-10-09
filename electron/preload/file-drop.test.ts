import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const electron = vi.hoisted(() => ({ invoke: vi.fn(), getPathForFile: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: electron.invoke }, webUtils: { getPathForFile: electron.getPathForFile } }))
import { installFileDropCapture, openDroppedFiles, readDroppedFiles } from './file-drop.js'

class NativeFile { constructor(public name: string) {} }
class Input { constructor(public type: string) {} }
class IsolatedWindow {
  top = this
  listeners = new Map<string, Array<{ callback: (event: any) => void; capture: boolean }>>()
  addEventListener(type: string, callback: (event: any) => void, capture = false) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], { callback, capture }])
  }
  removeEventListener(type: string, callback: (event: any) => void, capture = false) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item.callback !== callback || item.capture !== capture))
  }
  dispatch(event: any, page = (_event: any) => {}, bubbles = true) {
    for (const item of [...this.listeners.get(event.type) ?? []].filter(item => item.capture)) item.callback(event)
    page(event)
    if (bubbles) for (const item of [...this.listeners.get(event.type) ?? []].filter(item => !item.capture)) item.callback(event)
  }
}
function drop(files: unknown[] = [new NativeFile('report.pdf')], options: { trusted?: boolean; path?: unknown[]; type?: string } = {}) {
  return { type: options.type ?? 'drop', isTrusted: options.trusted ?? true, defaultPrevented: false,
    dataTransfer: { types: ['Files'], files, dropEffect: 'none' }, composedPath: () => options.path ?? [],
    preventDefault() { this.defaultPrevented = true } }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }
async function allowGuestFallback() {
  window.dispatch(drop([], { type: 'dragenter' })); await settle(); electron.invoke.mockClear()
}
let window: IsolatedWindow, dispose = () => {}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.resetAllMocks()
  window = new IsolatedWindow(); vi.stubGlobal('window', window); vi.stubGlobal('File', NativeFile); vi.stubGlobal('HTMLInputElement', Input)
  electron.getPathForFile.mockImplementation((file: NativeFile) => file.name === 'generated.txt' ? '' : `E:/controlled/${file.name}`)
  electron.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE) return { nonce: 'private-nonce', fallbackAllowed: true }
    if (channel === IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE) return { token: 'private-token' }
    if (channel === IPC_CHANNELS.WEBVIEW_FILE_DROP) return [{ filename: 'report.pdf', dataUrl: 'data:application/pdf;base64,AA==', mime: 'application/pdf', size: 1 }]
  })
})
afterEach(() => { dispose(); dispose = () => {}; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('isolated native drop capture', () => {
  it('ignores synthetic events, page path properties and files without a native path', async () => {
    dispose = installFileDropCapture('host')
    window.dispatch(drop(undefined, { trusted: false }))
    window.dispatch(drop([{ path: 'E:/unselected/private.txt', name: 'report.pdf' }]))
    window.dispatch(drop([new NativeFile('generated.txt')]))
    await expect(readDroppedFiles()).rejects.toThrow('native file drop')
    expect(electron.invoke).not.toHaveBeenCalled()
    expect(electron.getPathForFile).toHaveBeenCalledTimes(1)
  })

  it('captures native paths before host handlers and consumes the private token only once', async () => {
    dispose = installFileDropCapture('host')
    let reading: ReturnType<typeof readDroppedFiles> | undefined
    window.dispatch(drop(), () => { reading = (readDroppedFiles as Function)(['E:/unselected/private.txt']) })
    await expect(reading).resolves.toMatchObject([{ filename: 'report.pdf' }])
    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE],
      [IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE, { nonce: 'private-nonce', paths: ['E:/controlled/report.pdf'] }],
      [IPC_CHANNELS.WEBVIEW_FILE_DROP, { token: 'private-token' }],
    ])
    await expect(openDroppedFiles()).rejects.toThrow('native file drop')
  })

  it('waits for native capture when the host consumes during the drop event', async () => {
    dispose = installFileDropCapture('host')
    let prepare!: (value: unknown) => void
    electron.invoke.mockImplementationOnce(() => new Promise(resolve => { prepare = resolve }))
    window.dispatch(drop())
    const opening = openDroppedFiles(); expect(electron.invoke).toHaveBeenCalledTimes(1)
    prepare({ nonce: 'fresh-nonce' }); await opening
    expect(electron.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, { token: 'private-token' })
  })

  it('expires an unused drop and permits a new native selection', async () => {
    dispose = installFileDropCapture('host'); window.dispatch(drop()); await settle()
    vi.setSystemTime(60_001)
    await expect(readDroppedFiles()).rejects.toThrow('native file drop')
    expect(electron.invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.WEBVIEW_FILE_DROP, expect.anything())
    window.dispatch(drop()); await expect(openDroppedFiles()).resolves.toBeUndefined()
  })

  it.each([{}, { nonce: '' }])('rejects an invalid challenge and recovers on another drop: %j', response => {
    dispose = installFileDropCapture('host'); electron.invoke.mockResolvedValueOnce(response); window.dispatch(drop())
    return expect(readDroppedFiles()).rejects.toThrow('authorization is unavailable').then(async () => {
      window.dispatch(drop()); await expect(readDroppedFiles()).resolves.toHaveLength(1)
    })
  })

  it('does not reuse an older selection after a trusted drop with no native files', async () => {
    dispose = installFileDropCapture('host'); window.dispatch(drop()); await settle()
    window.dispatch(drop([new NativeFile('generated.txt')]))
    await expect(readDroppedFiles()).rejects.toThrow('native file drop')
  })

  it('opens an unhandled guest drop after the page has observed the original event', async () => {
    dispose = installFileDropCapture('guest'); await allowGuestFallback(); const event = drop()
    window.dispatch(event, current => { expect(current.defaultPrevented).toBe(false); expect(electron.invoke).not.toHaveBeenCalled() })
    expect(event.defaultPrevented).toBe(true); await settle()
    expect(electron.invoke).toHaveBeenCalledWith(IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE, { nonce: 'private-nonce', paths: ['E:/controlled/report.pdf'] })
    expect(electron.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, { token: 'private-token' })
    await expect(readDroppedFiles()).rejects.toThrow('native file drop')
  })

  it('preserves a page upload handler and a native file input', async () => {
    dispose = installFileDropCapture('guest'); await allowGuestFallback()
    window.dispatch(drop(), event => event.preventDefault())
    await allowGuestFallback()
    const inputDrop = drop(undefined, { path: [new Input('file')] }); window.dispatch(inputDrop)
    expect(inputDrop.defaultPrevented).toBe(false); await settle(); expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('cleans deferred listeners when the page stops propagation or the preload is disposed', async () => {
    dispose = installFileDropCapture('guest'); await allowGuestFallback(); window.dispatch(drop(), () => {}, false)
    await vi.runOnlyPendingTimersAsync(); expect(electron.invoke).not.toHaveBeenCalled()
    expect(window.listeners.get('drop')).toHaveLength(1)
    await allowGuestFallback(); window.dispatch(drop(undefined, { type: 'dragover' }), () => {}, false)
    dispose(); expect(vi.getTimerCount()).toBe(0)
    expect([...window.listeners.values()].flat()).toHaveLength(0)
  })

  it('preserves guest defaults until the actual browser host authorizes local viewing', async () => {
    dispose = installFileDropCapture('guest')
    const unprepared = drop(); window.dispatch(unprepared); expect(unprepared.defaultPrevented).toBe(false)
    electron.invoke.mockResolvedValueOnce({ nonce: 'main-window-nonce', fallbackAllowed: false })
    await allowGuestFallback()
    const mainWindowDrop = drop(), dragover = drop([], { type: 'dragover' })
    window.dispatch(dragover); window.dispatch(mainWindowDrop)
    expect(dragover.defaultPrevented).toBe(false); expect(mainWindowDrop.defaultPrevented).toBe(false)
    expect(electron.invoke).not.toHaveBeenCalled()
  })

  it('requires a fresh browser authorization before converting a drop to file viewing', async () => {
    dispose = installFileDropCapture('guest'); await allowGuestFallback()
    electron.invoke.mockResolvedValueOnce({ nonce: 'revoked-nonce', fallbackAllowed: false })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      window.dispatch(drop()); await settle()
      expect(electron.invoke.mock.calls).toEqual([[IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE]])
      expect(warning).toHaveBeenCalledOnce()
    } finally { warning.mockRestore() }
  })
})
