import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  timers: new Map<string, NodeJS.Timeout>(),
  state: { isMaximized: false, bounds: {} },
  save: vi.fn(),
}))
vi.mock('electron', () => ({ BrowserWindow: {} }))
vi.mock('../store/window-store.js', () => ({ windowStore: { getOrDefault: () => fixture.state, save: fixture.save } }))
vi.mock('../window-state.js', () => ({ windowState: { boundsSaveTimers: fixture.timers } }))
vi.mock('../ipc/window-control-ipc.js', () => ({ setAlwaysOnTopForWindow: vi.fn(), toggleMaximizeForWindow: vi.fn() }))
vi.mock('./window-utils.js', () => ({ safeLogWindowTrace: vi.fn(), findWindowIdByWin: vi.fn() }))
vi.mock('../utils/fullscreen-tracker.js', () => ({ isTrackedFullscreen: () => false }))

import { setupBoundsTracking } from './window-events.js'

function createWindow() {
  const win = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    getBounds: vi.fn(() => {
      if (win.destroyed) throw new Error('Object has been destroyed')
      return { x: 10, y: 20, width: 420, height: 800 }
    }),
  })
  setupBoundsTracking(win as unknown as BrowserWindow, 'fixture')
  return win
}

beforeEach(() => { vi.useFakeTimers(); fixture.save.mockClear(); fixture.timers.clear() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('delayed window persistence', () => {
  it('does not access native bounds after a pending window is destroyed', () => {
    const win = createWindow()
    win.emit('resize')
    win.destroyed = true
    win.emit('closed')
    expect(() => vi.advanceTimersByTime(600)).not.toThrow()
    expect(win.getBounds).not.toHaveBeenCalled()
    expect(fixture.timers.size).toBe(0)
  })

  it('preserves the replacement window timer when an older window closes', () => {
    const older = createWindow()
    older.emit('move')
    const current = createWindow()
    current.emit('resize')
    older.destroyed = true
    older.emit('closed')
    vi.advanceTimersByTime(600)
    expect(current.getBounds).toHaveBeenCalledOnce()
    expect(fixture.save).toHaveBeenCalledOnce()
    expect(fixture.timers.size).toBe(0)
  })
})
