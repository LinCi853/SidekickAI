import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  callbacks: new Map<string, () => void>(),
  failures: new Set<string>(),
  hook: { on: vi.fn(), start: vi.fn(), stop: vi.fn() },
}))
vi.mock('electron', () => ({ globalShortcut: {
  register: (accelerator: string, callback: () => void) => {
    if (fixture.failures.has(accelerator) || fixture.callbacks.has(accelerator)) return false
    fixture.callbacks.set(accelerator, callback)
    return true
  },
  unregister: (accelerator: string) => fixture.callbacks.delete(accelerator),
  unregisterAll: () => fixture.callbacks.clear(),
  isRegistered: (accelerator: string) => fixture.callbacks.has(accelerator),
} }))
vi.mock('./uiohook.js', () => ({
  UiohookKey: { Space: 32, Q: 81, K: 75, V: 86, Escape: 27, LeftAlt: 56, LeftControl: 29, LeftShift: 42, LeftMeta: 3675 },
  EventType: { EVENT_KEY_PRESSED: 7, EVENT_KEY_RELEASED: 8 },
  uIOhook: fixture.hook,
  getUiohookAvailability: () => ({ available: true, error: null }),
}))
vi.mock('./store.js', () => ({
  DEFAULT_HOTKEYS: { toggleMainWindow: 'Alt+Space', toggleDetachedWindows: 'Alt+Q' },
  HOTKEY_LABELS: {},
  hotkeyStore: { get: vi.fn(), set: vi.fn() },
  storeKey: (action: string) => action,
  enabledStoreKey: (action: string) => action,
}))
vi.mock('../utils/permission-manager.js', () => ({ checkAccessibilityPermission: () => true }))
vi.mock('../utils/browser-hotkey-fallback.js', () => ({ dispatchBrowserHotkeyFallback: vi.fn() }))

import { HotkeyManager } from './manager'

let manager: HotkeyManager
beforeEach(() => {
  vi.stubEnv('SIDEKICK_TEST_SESSION', 'recording-reproduction-' + process.pid + '-' + Math.random())
  fixture.callbacks.clear()
  fixture.failures.clear()
  vi.clearAllMocks()
  manager = new HotkeyManager()
})
afterEach(() => {
  manager.unregisterAll()
  vi.unstubAllEnvs()
})

describe('recording registration restoration', () => {
  it('restores a new registration created during recording', async () => {
    await manager.startRecording(vi.fn())
    await manager.register('Ctrl+K', vi.fn())
    manager.stopRecording()
    expect(fixture.callbacks.has('Ctrl+K')).toBe(true)
    expect(manager.registrationStates.get('Ctrl+K')).toBe('registered')
  })

  it('reports fallback when the OS refuses restoration after recording', async () => {
    const action = vi.fn()
    await manager.register('Alt+Q', action)
    await manager.startRecording(vi.fn())
    fixture.failures.add('Alt+Q')
    manager.stopRecording()
    expect(fixture.callbacks.has('Alt+Q')).toBe(false)
    expect(manager.registrationStates.get('Alt+Q')).toBe('fallback')
    const keydown = fixture.hook.on.mock.calls.find(([event]) => event === 'keydown')![1]
    keydown({ type: 7, keycode: 56, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false })
    keydown({ type: 7, keycode: 81, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false })
    expect(action).toHaveBeenCalledOnce()
  })

  it('keeps a disabled binding removed when recording ends', async () => {
    await manager.register('Alt+Q', vi.fn())
    await manager.startRecording(vi.fn())
    manager.unregister('Alt+Q')
    manager.stopRecording()
    expect(fixture.callbacks.has('Alt+Q')).toBe(false)
    expect(manager.isRegistered('Alt+Q')).toBe(false)
  })

  it('restores the current callback when a binding changes during recording', async () => {
    const previous = vi.fn(), current = vi.fn()
    await manager.register('Alt+Q', previous)
    const previousSystemCallback = fixture.callbacks.get('Alt+Q')!
    await manager.startRecording(vi.fn())
    await manager.register('Alt+Q', current)
    manager.stopRecording()
    previousSystemCallback()
    fixture.callbacks.get('Alt+Q')!()
    expect(previous).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledOnce()
  })

  it('restores browser shortcuts added during recording', async () => {
    await manager.startRecording(vi.fn())
    const action = vi.fn()
    expect(manager.registerBrowserShortcut('Ctrl+K', action)).toBe(true)
    manager.stopRecording()
    fixture.callbacks.get('Ctrl+K')!()
    expect(action).toHaveBeenCalledOnce()
  })

  it('keeps restoration paused until the owner resumes', async () => {
    const action = vi.fn()
    await manager.register('Alt+Q', action)
    await manager.startRecording(vi.fn())
    manager.pauseAllShortcuts()
    manager.stopRecording()
    expect(fixture.callbacks.has('Alt+Q')).toBe(false)
    manager.resumeAllShortcuts()
    fixture.callbacks.get('Alt+Q')!()
    expect(action).toHaveBeenCalledOnce()
  })

  it('does not change a healthy backend when recording is already stopped', async () => {
    await manager.register('Alt+Q', vi.fn())
    const callback = fixture.callbacks.get('Alt+Q')
    manager.stopRecording()
    manager.stopRecording()
    expect(fixture.callbacks.get('Alt+Q')).toBe(callback)
    expect(manager.registrationStates.get('Alt+Q')).toBe('registered')
  })

  it('releases an unavailable restored binding and reports the failed backend', async () => {
    await manager.register('Alt+Q', vi.fn())
    await manager.startRecording(vi.fn())
    manager.uiohookStarted = false
    fixture.failures.add('Alt+Q')
    manager.stopRecording()
    expect(manager.isRegistered('Alt+Q')).toBe(false)
    expect(manager.ownershipLeases.has('Alt+Q')).toBe(false)
    expect(manager.registrationStates.get('Alt+Q')).toBe('unavailable')
  })
})

