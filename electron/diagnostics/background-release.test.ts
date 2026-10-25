// electron/diagnostics/background-release.test.ts
//
// 纯后台释放：只关已隐藏/最小化的次窗口，走 close()，出声与主窗/预览窗保留，
// 应用仍有焦点时不释放。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeWin {
  id: string
  visible: boolean
  minimized: boolean
  webContents: { isDestroyed: () => boolean; isCurrentlyAudible: () => boolean }
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
}

const allWindows: FakeWin[] = []
let focusedWindow: unknown = null

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => allWindows,
    getFocusedWindow: () => focusedWindow,
  },
  webContents: {
    getAllWebContents: () => [],
  },
  app: { isQuitting: false },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}))

const windowState = vi.hoisted(() => ({
  mainWindow: null as unknown,
  previewWindow: null as unknown,
}))
vi.mock('../platform/window/window-state.js', () => ({ windowState }))

const settings = vi.hoisted(() => ({ lowMemoryMode: false }))
vi.mock('../store/low-memory-mode.js', () => ({
  isLowMemoryMode: () => settings.lowMemoryMode === true,
}))

function makeWin(
  id: string,
  options: { visible?: boolean; minimized?: boolean; audible?: boolean } = {},
): FakeWin {
  const win: FakeWin = {
    id,
    visible: options.visible ?? false,
    minimized: options.minimized ?? false,
    webContents: {
      isDestroyed: () => false,
      isCurrentlyAudible: () => options.audible ?? false,
    },
    close: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
  }
  allWindows.push(win)
  return win
}

const { closeSecondaryWindows, scheduleBackgroundRelease, cancelBackgroundRelease } = await import(
  './background-release.js'
)
const { isBackgroundClose } = await import('../platform/window/window-retirement.js')

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  allWindows.length = 0
  focusedWindow = null
  windowState.mainWindow = null
  windowState.previewWindow = null
  settings.lowMemoryMode = false
})

afterEach(() => {
  cancelBackgroundRelease()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('closeSecondaryWindows', () => {
  it('closes hidden and minimized windows with close(), never destroy()', () => {
    const hidden = makeWin('hidden')
    const minimized = makeWin('minimized', { visible: true, minimized: true })
    expect(closeSecondaryWindows()).toBe(2)
    expect(hidden.close).toHaveBeenCalled()
    expect(minimized.close).toHaveBeenCalled()
    expect(hidden.destroy).not.toHaveBeenCalled()
    expect(isBackgroundClose(hidden as never)).toBe(true)
  })

  it('closes unfocused secondary windows even if still visible', () => {
    const visible = makeWin('visible', { visible: true })
    expect(closeSecondaryWindows()).toBe(1)
    expect(visible.close).toHaveBeenCalled()
  })

  it('keeps windows that play audio', () => {
    const audible = makeWin('audible', { audible: true })
    expect(closeSecondaryWindows()).toBe(0)
    expect(audible.close).not.toHaveBeenCalled()
  })

  it('keeps the main and voice preview windows', () => {
    const main = makeWin('main')
    const preview = makeWin('preview')
    windowState.mainWindow = main
    windowState.previewWindow = preview
    expect(closeSecondaryWindows()).toBe(0)
  })
})

describe('scheduleBackgroundRelease', () => {
  it('waits thirty minutes by default when low memory mode is off', () => {
    const hidden = makeWin('hidden')
    settings.lowMemoryMode = false
    scheduleBackgroundRelease()
    vi.advanceTimersByTime(29 * 60_000)
    expect(hidden.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(hidden.close).toHaveBeenCalled()
  })

  it('waits fifteen minutes when low memory mode is on', () => {
    const hidden = makeWin('hidden')
    settings.lowMemoryMode = true
    scheduleBackgroundRelease()
    vi.advanceTimersByTime(14 * 60_000)
    expect(hidden.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(hidden.close).toHaveBeenCalled()
  })

  it('does not release while a window of the app has focus', () => {
    const hidden = makeWin('hidden')
    focusedWindow = makeWin('settings', { visible: true })
    scheduleBackgroundRelease(1_000)
    vi.advanceTimersByTime(1_000)
    expect(hidden.close).not.toHaveBeenCalled()
  })

  it('does not release after the schedule is cancelled', () => {
    const hidden = makeWin('hidden')
    scheduleBackgroundRelease(1_000)
    cancelBackgroundRelease()
    vi.advanceTimersByTime(1_000)
    expect(hidden.close).not.toHaveBeenCalled()
  })
})
