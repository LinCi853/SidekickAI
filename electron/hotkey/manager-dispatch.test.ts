// electron/hotkey/manager-dispatch.test.ts — 双通路分发解耦回归测试
//
// 对应 2026-09 game-hotkey audit 复现的主缺陷：旧实现要求系统回调通过
// inputState.claim（钩子物理按键状态）校验，钩子无事件/漏事件时
// globalShortcut 成功注册的热键也被应用自己丢弃。
// 新架构：registered 状态仅系统通路分发（不依赖钩子），fallback 状态仅钩子通路分发。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiohookEvent } from './types'

const fixture = vi.hoisted(() => ({
  globalShortcut: {
    register: vi.fn((_accelerator: string, _callback: () => void) => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
    unregisterAll: vi.fn(),
  },
  uiohook: {
    on: vi.fn((_event: string, _cb: (e: UiohookEvent) => void) => {}),
    start: vi.fn(),
    stop: vi.fn(),
  },
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
vi.mock('../utils/browser-hotkey-fallback.js', () => ({ dispatchBrowserHotkeyFallback: vi.fn() }))
vi.mock('../utils/permission-manager.js', () => ({ checkAccessibilityPermission: () => true }))

import { HotkeyManager } from './manager'

let manager: HotkeyManager

function systemCallbackOf(accelerator: string): () => void {
  const call = fixture.globalShortcut.register.mock.calls.find(([acc]) => acc === accelerator)
  expect(call, `globalShortcut.register 应已捕获 ${accelerator}`).toBeTruthy()
  return call![1] as () => void
}

function hookHandlerOf(event: 'keydown' | 'keyup'): (e: UiohookEvent) => void {
  const call = fixture.uiohook.on.mock.calls.find(([name]) => name === event)
  expect(call, `uiohook.on('${event}') 应已注册`).toBeTruthy()
  return call![1] as (e: UiohookEvent) => void
}

function keyEvent(keycode: number, alt: boolean, ctrl: boolean, down: boolean): UiohookEvent {
  return { type: down ? 7 : 8, keycode, altKey: alt, ctrlKey: ctrl, shiftKey: false, metaKey: false }
}

beforeEach(() => {
  vi.stubEnv('SIDEKICK_TEST_SESSION', `dispatch-test-${process.pid}-${Math.random()}`)
  vi.useFakeTimers()
  vi.clearAllMocks()
  fixture.globalShortcut.register.mockReturnValue(true)
  fixture.globalShortcut.isRegistered.mockReturnValue(false)
  manager = new HotkeyManager()
})

afterEach(() => {
  manager.unregisterAll()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('热键双通路分发解耦', () => {
  it('系统回调不依赖钩子物理状态：钩子无事件时 globalShortcut 触发仍然生效', async () => {
    const action = vi.fn()
    await manager.register('Alt+Space', action)
    const systemCallback = systemCallbackOf('Alt+Space')

    // 钩子从未观察到任何键盘事件（模拟钩子失效/被拦截/原生模块缺失），
    // 直接到达的系统回调（WM_HOTKEY）必须触发业务回调 —— 旧实现在此丢弃
    systemCallback()
    expect(action).toHaveBeenCalledTimes(1)

    // 钩子未观察到按下：时间窗口兜底抑制长按连切（Electron globalShortcut 无 MOD_NOREPEAT）
    vi.advanceTimersByTime(100)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('长按仲裁：钩子观察到按下期间抑制重复，观察到释放后放行新按压', async () => {
    const action = vi.fn()
    await manager.register('Alt+Space', action)
    const keydown = hookHandlerOf('keydown')
    const keyup = hookHandlerOf('keyup')
    const systemCallback = systemCallbackOf('Alt+Space')

    // 物理按下 Alt+Space（钩子观察到；registered 状态下钩子匹配不得分发）
    keydown(keyEvent(56, true, false, true))
    keydown(keyEvent(32, true, false, true))
    expect(action).not.toHaveBeenCalled()

    systemCallback()
    expect(action).toHaveBeenCalledTimes(1)

    // 按住不放的 WM_HOTKEY 重复：抑制（等价 MOD_NOREPEAT 单次触发语义）
    vi.advanceTimersByTime(30)
    systemCallback()
    vi.advanceTimersByTime(600)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(1)

    // 释放后再次按压：立即放行，不受时间窗口影响
    keyup(keyEvent(32, true, false, false))
    vi.advanceTimersByTime(10)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('钩子中途失效的 held 滞留由 HOLD_CAP 自愈，不再永久抑制', async () => {
    const action = vi.fn()
    await manager.register('Alt+Space', action)
    const keydown = hookHandlerOf('keydown')
    const keyup = hookHandlerOf('keyup')
    const systemCallback = systemCallbackOf('Alt+Space')

    keydown(keyEvent(56, true, false, true))
    keydown(keyEvent(32, true, false, true))
    systemCallback()
    expect(action).toHaveBeenCalledTimes(1)
    // keyup 丢失（Windows 已知缺口）：held 状态滞留
    vi.advanceTimersByTime(3100)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(2)
    // 释放最终被观察到后恢复正常（避免与自愈触发同毫秒，先推进时钟再观察 keyup）
    vi.advanceTimersByTime(10)
    keyup(keyEvent(32, true, false, false))
    vi.advanceTimersByTime(10)
    systemCallback()
    expect(action).toHaveBeenCalledTimes(3)
  })

  it('状态门禁：registered 状态下钩子事件不分发，避免双触发', async () => {
    const action = vi.fn()
    await manager.register('Alt+Space', action)
    const keydown = hookHandlerOf('keydown')

    // 钩子观察到完整匹配的组合键，但系统注册成功 → 钩子通路必须沉默
    keydown(keyEvent(56, true, false, true))
    keydown(keyEvent(32, true, false, true))
    expect(action).not.toHaveBeenCalled()

    systemCallbackOf('Alt+Space')()
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('fallback 状态：钩子兜底分发（物理校验+消费防重复），系统回调沉默', async () => {
    fixture.globalShortcut.register.mockReturnValueOnce(false)
    const action = vi.fn()
    expect(await manager.register('Ctrl+K', action)).toBe(true)
    expect(manager.registrationStates.get('Ctrl+K')).toBe('fallback')

    const keydown = hookHandlerOf('keydown')
    keydown(keyEvent(29, false, true, true))
    keydown(keyEvent(75, false, true, true))
    expect(action).toHaveBeenCalledTimes(1)

    // 钩子通路的 claim 消费：按住不放的重复 keydown 不再触发
    vi.advanceTimersByTime(50)
    keydown(keyEvent(75, false, true, true))
    expect(action).toHaveBeenCalledTimes(1)

    // fallback 状态下（若仍收到）系统回调不得分发
    systemCallbackOf('Ctrl+K')()
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('迟到回调拒绝：注销后到达的旧系统回调不触发业务', async () => {
    const action = vi.fn()
    await manager.register('Alt+Space', action)
    const systemCallback = systemCallbackOf('Alt+Space')
    manager.unregister('Alt+Space')

    systemCallback()
    expect(action).not.toHaveBeenCalled()
  })

  it('状态订阅：注册/注销/钩子可用性变化时推送最新状态', async () => {
    const listener = vi.fn()
    const unsubscribe = manager.subscribeStatus(listener)
    expect(listener).toHaveBeenCalledTimes(1)
    await manager.register('Alt+Space', vi.fn())
    // subscribe 初始推送 + ensureUiohookStarted + 注册成功 = 3 次
    expect(listener).toHaveBeenCalledTimes(3)
    const status = listener.mock.calls[1][0]
    expect(status).toMatchObject({ uiohookStarted: true, hookError: null, paused: false })
    manager.unregister('Alt+Space')
    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
    await manager.register('Alt+Q', vi.fn())
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('getAllHotkeys：fallback 状态提供用户可读原因', async () => {
    fixture.globalShortcut.register.mockReturnValueOnce(false)
    await manager.register('Alt+Space', vi.fn())
    const fallbackItem = manager.getAllHotkeys().find((h) => h.accelerator === 'Alt+Space')
    expect(fallbackItem?.registration).toBe('fallback')
    expect(fallbackItem?.registrationReason).toContain('兜底')
  })

  it('钩子启动失败且系统注册失败 → 如实标记 unavailable（不得谎报 fallback）', async () => {
    fixture.uiohook.start.mockImplementationOnce(() => {
      throw new Error('hook broken')
    })
    fixture.globalShortcut.register.mockReturnValueOnce(false)
    expect(await manager.register('Alt+Q', vi.fn())).toBe(false)
    expect(manager.registrationStates.get('Alt+Q')).toBe('unavailable')
    const item = manager.getAllHotkeys().find((h) => h.accelerator === 'Alt+Q')
    expect(item?.registration).toBe('unavailable')
    expect(item?.registrationReason).toContain('不可用')
    expect(manager.getStatus().hookError).toContain('hook broken')
  })
})
