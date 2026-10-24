import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  cloud: false,
  browser: true,
  forward: true,
  targetAvailable: true,
  editable: false,
  window: null as any,
  maximize: vi.fn(),
  exitCloud: vi.fn(),
  top: vi.fn(),
}))

vi.mock('../platform/window/renderer-loader.js', () => ({ isBrowserWindowContents: () => fixture.browser }))
vi.mock('../platform/window/window-utils.js', () => ({ findWindowIdByWin: () => 'window-a' }))
vi.mock('./webview-focus.js', () => ({ isGuestFocusEditable: () => fixture.editable }))
vi.mock('../utils/cloud-pc.js', () => ({ isCloudPc: () => fixture.cloud, forceExitCloudPc: fixture.exitCloud }))
vi.mock('../utils/browser-hotkey-fallback.js', () => ({ tryForward: () => fixture.forward }))
vi.mock('../utils/fullscreen-tracker.js', () => ({ isTrackedFullscreen: () => false }))
vi.mock('../store/window-store.js', () => ({ windowStore: { getOrDefault: () => ({}), save: vi.fn() } }))
vi.mock('../ipc/window-control-ipc.js', () => ({ setAlwaysOnTopForWindow: fixture.top, toggleMaximizeForWindow: fixture.maximize }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => fixture.window } }))
vi.mock('./webview-hotkey-target.js', () => ({
  trackWebviewHotkeyTarget: vi.fn(),
  captureWebviewHotkeyTarget: () => fixture.targetAvailable ? { webContentsId: 12, documentGeneration: 2, url: 'https://example.test/chat', tabId: 'tab-a', profileId: 'profile-a', windowId: 'window-a' } : null,
}))

import { attachWebviewHotkeyRouter } from './webview-hotkeys'

let guest: any
let parent: any
let handlers: Array<(event: any, input: any) => void>
function press(key: string, code: string, modifiers: string[] = [], extra: Record<string, unknown> = {}) {
  const event = { preventDefault: vi.fn() }
  const input = { type: 'keyDown', key, code, modifiers, isAutoRepeat: false, isComposing: false, ...extra }
  for (const handler of handlers) handler(event, input)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.cloud = false
  fixture.browser = true
  fixture.forward = true
  fixture.targetAvailable = true
  fixture.editable = false
  parent = { id: 11, send: vi.fn(), isDestroyed: () => false }
  handlers = []
  guest = { id: 12, isDestroyed: () => false, isFocused: () => true, on: (_event: string, handler: any) => handlers.push(handler) }
  fixture.window = {
    isDestroyed: () => false,
    isFocused: () => true,
    isFullScreen: () => false,
    isMaximized: () => false,
    isAlwaysOnTop: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setFullScreen: vi.fn(),
    unmaximize: vi.fn(),
  }
  attachWebviewHotkeyRouter(guest, parent, vi.fn())
})

describe('guest input behavior contract', () => {
  it.each([
    ['F5', 'F5', []],
    ['w', 'KeyW', ['control']],
    ['t', 'KeyT', ['control']],
  ])('passes %s through while cloud mode owns page input', (key, code, modifiers) => {
    fixture.cloud = true
    const event = press(key as string, code as string, modifiers as string[])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('retains the emergency cloud exit chord', () => {
    fixture.cloud = true
    const event = press('F12', 'F12', ['control', 'alt', 'shift'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.exitCloud).toHaveBeenCalledOnce()
  })

  it('does not close a tab during composition', () => {
    const event = press('w', 'KeyW', ['control'], { isComposing: true })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('cycles backward for control shift tab', () => {
    const event = press('Tab', 'Tab', ['control', 'shift'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'cycleTab', data: { reverse: true } }))
  })

  it('allows auto-repeat for tab-switch keys (hold Ctrl+Tab / Alt+1)', () => {
    const heldTab = press('Tab', 'Tab', ['control'], { isAutoRepeat: true })
    expect(heldTab.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'cycleTab' }))

    parent.send.mockClear()
    const heldDigit = press('1', 'Digit1', ['alt'], { isAutoRepeat: true })
    expect(heldDigit.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'switchTab' }))

    parent.send.mockClear()
    const heldOther = press('w', 'KeyW', ['control'], { isAutoRepeat: true })
    expect(heldOther.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('hold backquote opens shortcuts in every window (keydown)', () => {
    fixture.browser = false
    const event = press(String.fromCharCode(96), 'Backquote')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'openShortcuts' }))
  })

  it('hold backquote opens shortcuts in browser windows too', () => {
    fixture.browser = true
    const event = press(String.fromCharCode(96), 'Backquote')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'openShortcuts' }))
  })

  it('question mark is no longer a shortcuts trigger', () => {
    fixture.browser = false
    const event = press('?', 'Slash', ['shift'])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('passes the backquote through to page input while typing', () => {
    fixture.browser = false
    fixture.editable = true
    const event = press(String.fromCharCode(96), 'Backquote')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('leaves editing and search chords to the page while the input is focused', () => {
    // 在 AI 输入框里打字时，Ctrl+A/C/V/F/X 这类组合必须留给页面，
    // 不能被应用抢走（此前 passWhenTyping 从未被任何快捷键使用）。
    fixture.browser = false
    fixture.editable = true
    for (const [key, code] of [['f', 'KeyF'], ['e', 'KeyE'], ['k', 'KeyK'], ['p', 'KeyP'], ['g', 'KeyG']] as const) {
      parent.send.mockClear()
      const event = press(key, code, ['ctrl'])
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(parent.send).not.toHaveBeenCalled()
    }
  })

  it('still runs those chords when the page focus is not an editable field', () => {
    fixture.browser = false
    fixture.editable = false
    const event = press('f', 'KeyF', ['ctrl'])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'findInPage' }))
  })

  it('releasing backquote closes shortcuts (keyup)', () => {
    fixture.browser = false
    const event = press(String.fromCharCode(96), 'Backquote', [], { type: 'keyUp' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', expect.objectContaining({ action: 'closeShortcuts' }))
  })

  it('consumes a browser fullscreen duplicate without invoking maximize', () => {
    fixture.forward = false
    const event = press('F11', 'F11')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.window.setFullScreen).not.toHaveBeenCalled()
    expect(fixture.maximize).not.toHaveBeenCalled()
  })

  it('passes Alt+P through to the page', () => {
    fixture.forward = false
    const event = press('p', 'KeyP', ['alt'])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('opens browser DevTools with F12', () => {
    const event = press('F12', 'F12')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(parent.send).toHaveBeenCalledWith('browser:toggleDevTools')
  })

  it('does not dispatch from an unfocused window', () => {
    fixture.window.isFocused = () => false
    guest.isFocused = () => false
    fixture.targetAvailable = false
    press('w', 'KeyW', ['control'])
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('does not dispatch from a retired guest', () => {
    guest.isDestroyed = () => true
    press('w', 'KeyW', ['control'])
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('does not dispatch from a retired host', () => {
    parent.isDestroyed = () => true
    press('w', 'KeyW', ['control'])
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('passes through input when the target cannot be captured', () => {
    fixture.targetAvailable = false
    const event = press('w', 'KeyW', ['control'])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(parent.send).not.toHaveBeenCalled()
  })

  it('forwards the captured page identity with each guest action', () => {
    press('w', 'KeyW', ['control'])
    expect(parent.send).toHaveBeenCalledWith('webview:hotkey', {
      action: 'closeTab',
      target: { webContentsId: 12, documentGeneration: 2, url: 'https://example.test/chat', tabId: 'tab-a', profileId: 'profile-a', windowId: 'window-a' },
    })
  })
})
