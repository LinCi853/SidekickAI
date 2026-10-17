// electron/window/window-retirement.test.ts
//
// 后台窗口退役：无焦点闲置到点关闭；聚焦、置顶、出声、退出中不关。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => void>()
const guests: Array<{ hostWebContents: unknown; audible: boolean }> = []

let focusedWindow: unknown = null

vi.mock('electron', () => ({
  app: { isQuitting: false },
  BrowserWindow: {
    getFocusedWindow: () => focusedWindow,
  },
  webContents: {
    getAllWebContents: () => guests.map((guest) => ({
      hostWebContents: guest.hostWebContents,
      isDestroyed: () => false,
      getType: () => 'webview',
      isCurrentlyAudible: () => guest.audible,
    })),
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
  },
}))

function makeWin(id: string, visible = false) {
  const host = { audible: false, isDestroyed: () => false, isCurrentlyAudible: () => host.audible }
  const win = {
    id,
    destroyed: false,
    visible,
    minimized: false,
    alwaysOnTop: false,
    webContents: host,
    close: vi.fn(() => { win.destroyed = true }),
    on(event: string, cb: (...args: unknown[]) => void) { handlers.set(`${id}:${event}`, cb) },
    once(event: string, cb: (...args: unknown[]) => void) { handlers.set(`${id}:${event}`, cb) },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    isAlwaysOnTop: () => win.alwaysOnTop,
  }
  return win
}

const {
  registerWindowRetirement,
  resetWindowRetirementForTest,
  isBackgroundClose,
} = await import('./window-retirement.js')

const THIRTY_MINUTES = 30 * 60

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  resetWindowRetirementForTest()
  handlers.clear()
  guests.length = 0
  focusedWindow = null
})

afterEach(() => {
  resetWindowRetirementForTest()
  vi.useRealTimers()
})

describe('window retirement', () => {
  it('closes a hidden window after the idle timeout and marks it as a background close', () => {
    const win = makeWin('a', false)
    registerWindowRetirement(win as never, { seconds: 30 })
    vi.advanceTimersByTime(31_000)
    expect(win.close).toHaveBeenCalled()
    expect(isBackgroundClose(win as never)).toBe(true)
  })

  it('closes a minimized window after thirty minutes, not earlier', () => {
    const win = makeWin('a', true)
    win.minimized = true
    registerWindowRetirement(win as never, { seconds: THIRTY_MINUTES })
    vi.advanceTimersByTime(29 * 60_000)
    expect(win.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2 * 60_000)
    expect(win.close).toHaveBeenCalled()
  })

  it('closes a visible but unfocused window after the deadline', () => {
    const win = makeWin('a', true)
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(11_000)
    expect(win.close).toHaveBeenCalled()
  })

  it('keeps a focused window open', () => {
    const win = makeWin('a', true)
    focusedWindow = win
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(60_000)
    expect(win.close).not.toHaveBeenCalled()
  })

  it('keeps an always-on-top window open', () => {
    const win = makeWin('a', false)
    win.alwaysOnTop = true
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(60_000)
    expect(win.close).not.toHaveBeenCalled()
  })

  it('keeps a hidden window open while it plays audio', () => {
    const win = makeWin('a', false)
    win.webContents.audible = true
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(60_000)
    expect(win.close).not.toHaveBeenCalled()
  })

  it('keeps a hidden window open while one of its webviews plays audio', () => {
    const win = makeWin('a', false)
    guests.push({ hostWebContents: win.webContents, audible: true })
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(60_000)
    expect(win.close).not.toHaveBeenCalled()
  })

  it('tolerates a focused window without getParentWindow', () => {
    const win = makeWin('a', false)
    focusedWindow = { id: 'other' }
    registerWindowRetirement(win as never, { seconds: 10 })
    vi.advanceTimersByTime(11_000)
    expect(win.close).toHaveBeenCalled()
  })

  it('restarts the deadline when the window becomes focused again', () => {
    const win = makeWin('a', false)
    registerWindowRetirement(win as never, { seconds: 30 })
    vi.advanceTimersByTime(20_000)
    win.visible = true
    focusedWindow = win
    handlers.get('a:show')?.()
    vi.advanceTimersByTime(20_000)
    expect(win.close).not.toHaveBeenCalled()
    focusedWindow = null
    win.visible = false
    handlers.get('a:hide')?.()
    vi.advanceTimersByTime(31_000)
    expect(win.close).toHaveBeenCalled()
  })
})
