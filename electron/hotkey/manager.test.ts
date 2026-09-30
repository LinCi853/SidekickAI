// electron/hotkey/manager.test.ts — HotkeyManager 编排层测试
//
// 子模块（input-state / coexistence / ownership）各有专项测试；本文件覆盖
// manager 自身的注册/注销/暂停恢复/语音热键编排流程，globalShortcut 与
// uiohook 均为 mock，归属判断走真实 HotkeyOwnership。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
    unregisterAll: vi.fn(),
  },
  uiohook: { on: vi.fn(), start: vi.fn(), stop: vi.fn() },
  storeGet: vi.fn(() => undefined),
}))
vi.mock('electron', () => ({ globalShortcut: fixture.globalShortcut }))
vi.mock('./uiohook.js', () => ({
  UiohookKey: {
    Space: 32, Q: 81, V: 86, Escape: 27,
    A: 65, K: 75, LeftAlt: 56, RightAlt: 584,
    LeftControl: 29, RightControl: 585,
    LeftShift: 42, RightShift: 54,
    LeftMeta: 3675, RightMeta: 3676,
  },
  EventType: { EVENT_KEY_PRESSED: 7, EVENT_KEY_RELEASED: 8 },
  uIOhook: fixture.uiohook,
  getUiohookAvailability: () => ({ available: true, error: null }),
}))
vi.mock('./store.js', () => ({
  DEFAULT_HOTKEYS: { toggleMainWindow: 'Alt+Space', toggleDetachedWindows: 'Alt+Q' },
  HOTKEY_LABELS: { toggleMainWindow: '显示/隐藏主窗口', toggleDetachedWindows: '显示/隐藏脱离窗口' },
  hotkeyStore: { get: fixture.storeGet, set: vi.fn() },
  storeKey: (action: string) => `hotkey.${action}`,
  enabledStoreKey: (action: string) => `hotkey.enabled.${action}`,
}))
import { HotkeyManager } from './manager'

let manager: HotkeyManager
beforeEach(() => {
  // 隔离热键所有权命名空间：默认命名空间与本机真实运行实例共享管道，
  // 测试必须使用 edition-safety 契约规定的隔离命名空间，否则与运行中的应用冲突
  vi.stubEnv('SIDEKICK_TEST_SESSION', `manager-test-${process.pid}-${Math.random()}`)
  vi.clearAllMocks()
  fixture.globalShortcut.register.mockReturnValue(true)
  fixture.globalShortcut.isRegistered.mockReturnValue(false)
  manager = new HotkeyManager()
})
afterEach(() => {
  manager.unregisterAll()
  vi.unstubAllEnvs()
})

describe('HotkeyManager 编排', () => {
  it('register：globalShortcut 主路径成功时进入 registered 状态', async () => {
    expect(await manager.register('Alt+Space', () => {})).toBe(true)
    expect(manager.isRegistered('Alt+Space')).toBe(true)
    expect(fixture.globalShortcut.register).toHaveBeenCalledWith('Alt+Space', expect.any(Function))
    expect(manager.getStatus().uiohookStarted).toBe(true)
  })

  it('register：globalShortcut 失败但 uiohook 可用时回退为 fallback', async () => {
    fixture.globalShortcut.register.mockReturnValueOnce(false)
    expect(await manager.register('Ctrl+Alt+K', () => {})).toBe(true)
    // 回退路径不注销，仅标记 fallback 由 uiohook 兜底
    expect(manager.isRegistered('Ctrl+Alt+K')).toBe(true)
  })

  it('unregister：注销后 isRegistered 为 false', async () => {
    await manager.register('Alt+Space', () => {})
    manager.unregister('Alt+Space')
    expect(manager.isRegistered('Alt+Space')).toBe(false)
    expect(fixture.globalShortcut.unregister).toHaveBeenCalledWith('Alt+Space')
  })

  it('pause/resume：暂停时注销系统注册，恢复时重新注册', async () => {
    await manager.register('Alt+Space', () => {})
    const unregisterCalls = fixture.globalShortcut.unregister.mock.calls.length
    manager.pauseAllShortcuts()
    expect(fixture.globalShortcut.unregister.mock.calls.length).toBeGreaterThan(unregisterCalls)
    const registerCalls = fixture.globalShortcut.register.mock.calls.length
    manager.resumeAllShortcuts()
    expect(fixture.globalShortcut.register.mock.calls.length).toBeGreaterThan(registerCalls)
  })

  it('registerVoiceHotkey：uiohook 路径注册成功，cleanup 后状态复位', () => {
    const cleanup = manager.registerVoiceHotkey('Alt+V', () => {}, () => {})
    expect(typeof cleanup).toBe('function')
    expect(manager.getStatus()).toMatchObject({ voiceHotkeyRegistered: true, uiohookStarted: true })
    cleanup()
    expect(manager.getStatus().voiceHotkeyRegistered).toBe(false)
  })

  it('registerDefaultShortcuts：默认两个内置热键注册成功并记录 accelerator', async () => {
    const results = await manager.registerDefaultShortcuts({ toggleMainWindow: () => {}, toggleDetachedWindows: () => {} })
    expect(results).toEqual({ toggleMainWindow: true, toggleDetachedWindows: true })
    expect(manager.getActionAccelerator('toggleMainWindow')).toBe('Alt+Space')
    expect(manager.getAllHotkeys()).toHaveLength(2)
  })
})
