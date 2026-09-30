import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  current: null as any, contexts: [] as any[], owners: new Map<string, { context: any; callback: () => void }>(),
  reserved: false, nativeError: false,
  keys: { Alt: 56, AltRight: 3640, Ctrl: 29, CtrlRight: 3613, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676, Space: 57, Q: 16, V: 47 },
}))
vi.mock('electron', () => {
  return { globalShortcut: {
    isRegistered: (key: string) => fixture.owners.get(key)?.context === fixture.current,
    register: (key: string, callback: () => void) => {
      if (fixture.nativeError) throw new Error('Native fixture failure')
      if (fixture.reserved || fixture.owners.has(key)) return false
      fixture.owners.set(key, { context: fixture.current, callback }); return true
    },
    unregister: (key: string) => { if (fixture.owners.get(key)?.context === fixture.current) fixture.owners.delete(key) },
    unregisterAll: () => { for (const [key, entry] of fixture.owners) if (entry.context === fixture.current) fixture.owners.delete(key) },
  } }
})
vi.mock('./uiohook.js', () => {
  return { UiohookKey: fixture.keys, EventType: { EVENT_KEY_PRESSED: 4, EVENT_KEY_RELEASED: 5 }, uIOhook: {
    start() { fixture.current.started = true }, stop() { fixture.current.started = false },
    on(event: string, callback: (value: unknown) => void) { fixture.current.listeners.set(event, callback) },
  }, getUiohookAvailability: () => ({ available: true, error: null }) }
})
vi.mock('./store.js', () => ({
  DEFAULT_HOTKEYS: { toggleMainWindow: 'Alt+Space', toggleDetachedWindows: 'Alt+Q', backgroundVoice: 'Alt+V' },
  HOTKEY_LABELS: {}, TRIGGER_DEBOUNCE_MS: 200, hotkeyStore: { get() {}, set() {} }, storeKey: (action: string) => action, enabledStoreKey: (action: string) => action,
}))
vi.mock('../utils/browser-hotkey-fallback.js', () => ({ dispatchBrowserHotkeyFallback() {} }))
vi.mock('../utils/permission-manager.js', () => ({ checkAccessibilityPermission: () => true }))

beforeEach(() => {
  fixture.contexts = []; fixture.owners.clear(); fixture.reserved = false; fixture.nativeError = false
  vi.stubEnv('SIDEKICK_TEST_SESSION', `shortcut-fixture-${process.pid}-${Math.random()}`)
})
afterEach(() => {
  for (const context of fixture.contexts) { fixture.current = context; context.manager?.unregisterAll() }
  vi.unstubAllEnvs()
})

async function manager() {
  const context = { listeners: new Map(), started: false, manager: null as any }
  fixture.current = context
  fixture.contexts.push(context)
  vi.resetModules()
  const { HotkeyManager } = await import('./manager')
  context.manager = new HotkeyManager()
  return new Proxy(context.manager, { get(target, key) {
    const value = target[key]
    return typeof value === 'function' ? (...args: unknown[]) => { fixture.current = context; return value.apply(target, args) } : value
  } })
}

function press(keycode: number) {
  for (const context of fixture.contexts) {
    fixture.current = context
    if (!context.started) continue
    for (const key of [fixture.keys.Alt, keycode]) context.listeners.get('keydown')?.({ type: 4, keycode: key, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false })
  }
}

function release(keycode: number) {
  for (const context of fixture.contexts) {
    fixture.current = context
    if (!context.started) continue
    for (const key of [keycode, fixture.keys.Alt]) context.listeners.get('keyup')?.({ type: 5, keycode: key, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false })
  }
}

/** 模拟 OS 向注册者投递 WM_HOTKEY（系统通路；registered 状态下的唯一分发路径） */
function fireSystem(key: string) {
  for (const context of fixture.contexts) {
    const entry = fixture.owners.get(key)
    if (entry && entry.context === context) {
      fixture.current = context
      entry.callback()
    }
  }
}

describe('hotkey ownership between application instances', () => {
  it('does not invoke a second hook fallback when another instance owns the OS shortcut', async () => {
    const first = await manager(), second = await manager()
    const firstAction = vi.fn(), secondAction = vi.fn()
    await first.register('Alt+Q', firstAction)
    await second.register('Alt+Q', secondAction)
    // registered 状态下系统回调是唯一分发路径，钩子事件不得重复触发
    fireSystem('Alt+Q')
    press(fixture.keys.Q)
    expect(firstAction).toHaveBeenCalledOnce()
    expect(secondAction).not.toHaveBeenCalled()
  })
  it('keeps one fallback owner for a system-reserved shortcut', async () => {
    fixture.reserved = true
    const first = await manager(), second = await manager()
    const firstAction = vi.fn(), secondAction = vi.fn()
    await first.register('Alt+Space', firstAction)
    await second.register('Alt+Space', secondAction)
    press(fixture.keys.Space)
    expect(firstAction).toHaveBeenCalledOnce()
    expect(secondAction).not.toHaveBeenCalled()
    expect(second.getAllHotkeys().find((item: any) => item.action === 'toggleMainWindow')).toMatchObject({ registration: 'conflict' })
  })
  it('canonicalizes aliases and allows ownership transfer after explicit removal', async () => {
    const first = await manager(), second = await manager()
    expect(await first.register('Alt+Q', vi.fn())).toBe(true)
    expect(await second.register('Option+Q', vi.fn())).toBe(false)
    first.unregister('Alt+Q')
    expect(await second.register('Option+Q', vi.fn())).toBe(true)
  })
  it('retains ownership during an application pause', async () => {
    const first = await manager(), second = await manager()
    const action = vi.fn()
    await first.register('Alt+Q', action)
    first.pauseAllShortcuts()
    expect(await second.register('Alt+Q', vi.fn())).toBe(false)
    first.resumeAllShortcuts()
    // 恢复后系统通路重新生效，钩子事件不得额外触发
    release(fixture.keys.Q)
    press(fixture.keys.Q)
    expect(action).not.toHaveBeenCalled()
    fireSystem('Alt+Q')
    expect(action).toHaveBeenCalledOnce()
  })
  it('releases ownership when native registration throws', async () => {
    const first = await manager(), second = await manager()
    fixture.nativeError = true
    expect(await first.register('Alt+Q', vi.fn())).toBe(false)
    fixture.nativeError = false
    expect(await second.register('Alt+Q', vi.fn())).toBe(true)
    expect(first.isRegistered('Alt+Q')).toBe(false)
  })
  it('does not steal a peer hook shortcut while recording', async () => {
    fixture.reserved = true
    const first = await manager(), second = await manager()
    const action = vi.fn(), result = vi.fn()
    await first.register('Alt+Space', action)
    await second.startRecording(result)
    press(fixture.keys.Space)
    expect(action).toHaveBeenCalledOnce()
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ accelerator: 'Alt+Space', reason: expect.stringContaining('另一个工百窗实例') }))
  })
})

describe('voice shortcut ownership', () => {
  it('prevents a peer shortcut from competing with a held voice binding and releases the hold on disposal', async () => {
    const first = await manager(), second = await manager()
    const down = vi.fn(), up = vi.fn(), peer = vi.fn()
    first.registerVoiceHotkey('Alt+V', down, up)
    expect(await second.register('Alt+V', peer)).toBe(false)
    press(fixture.keys.V)
    expect(down).toHaveBeenCalledOnce()
    expect(peer).not.toHaveBeenCalled()
    first.unregisterAll()
    expect(up).toHaveBeenCalledOnce()
    expect(await second.register('Alt+V', peer)).toBe(true)
  })
  it.each(['pause', 'recording'])('ends an active voice hold before %s', async mode => {
    const first = await manager()
    const down = vi.fn(), up = vi.fn()
    first.registerVoiceHotkey('Alt+V', down, up)
    press(fixture.keys.V)
    if (mode === 'pause') first.pauseAllShortcuts()
    else await first.startRecording(vi.fn())
    expect(up).toHaveBeenCalledOnce()
    release(fixture.keys.V)
    expect(up).toHaveBeenCalledOnce()
  })
  it('does not let a stale voice disposer remove a newer binding', async () => {
    const first = await manager()
    const old = first.registerVoiceHotkey('Alt+V', vi.fn(), vi.fn())
    const next = vi.fn()
    first.registerVoiceHotkey('Alt+Q', next, vi.fn())
    old()
    press(fixture.keys.Q)
    expect(next).toHaveBeenCalledOnce()
  })
})
