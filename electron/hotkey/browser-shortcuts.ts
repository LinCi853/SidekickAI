// electron/hotkey/browser-shortcuts.ts — 浏览器窗口全局快捷键（自 manager.ts 拆分的功能簇）
//
// 包含：注册/注销 scope='global' 的浏览器快捷键（globalShortcut 主路径 + uiohook 兜底）。
// 全部为函数式实现：第一参数 host 为 HotkeyManager 实例，
// 通过 BrowserShortcutsHost 协作接口访问 manager 的字段与方法。

import { globalShortcut } from 'electron'
import type { HotkeyOwnership, HotkeyLease } from '../../packages/desktop-common/hotkey-ownership.js'
import { parseAccelerator } from './accelerator.js'
import type { HotkeyRecordingCallback } from './types.js'

/** 浏览器快捷键簇与 HotkeyManager 的协作接口：声明本模块用到的 manager 字段与方法 */
export interface BrowserShortcutsHost {
  /** accelerator -> 回调（已注册项，含 globalShortcut 与 uiohook 兜底） */
  registered: Map<string, () => void>
  /** 浏览器窗口快捷键 accelerator -> 回调（C4：scope='global' 的浏览器快捷键，独立跟踪） */
  browserShortcuts: Map<string, () => void>
  ownership: HotkeyOwnership
  ownershipLeases: Map<string, HotkeyLease>
  registrationStates: Map<string, 'registered' | 'fallback' | 'conflict' | 'unavailable'>
  /** 已注册 accelerator 的 uiohook 匹配条件缓存 */
  uiohookMatchers: Map<string, ReturnType<typeof parseAccelerator> & { callback: () => void }>
  /** 最近触发时间戳（用于去重） */
  lastTriggeredAt: Map<string, number>
  /** uiohook 是否已启动 */
  uiohookStarted: boolean
  /** 暂停状态：true 时跳过所有全局热键匹配（如使用指南窗口打开时） */
  _paused: boolean
  /** 热键录制状态：null 表示未录制，非 null 表示录制中（含回调） */
  _recordingCallback: HotkeyRecordingCallback | null
  /** 统一触发入口：200ms 去重，避免 globalShortcut + uiohook 双触发 */
  trigger(accelerator: string, callback: () => void): void
  /** Start the input hook once. */
  ensureUiohookStarted(): void
}

/**
 * 注册浏览器窗口全局快捷键（C4：scope='global' 的浏览器快捷键）。
 *
 * 走 globalShortcut 主路径 + uiohook 兜底，与内置热键 register() 一致；
 * 独立跟踪到 browserShortcuts 映射，避免与内置热键回调混淆，
 * 注销时可按 accelerator 精确移除。
 *
 * @returns Whether an owned shortcut backend is available.
 */
export function registerBrowserShortcut(host: BrowserShortcutsHost, accelerator: string, callback: () => void): boolean {
  // 若已注册同名浏览器快捷键，先注销
  if (host.browserShortcuts.has(accelerator)) {
    unregisterBrowserShortcut(host, accelerator)
  }
  const lease = host.ownership.acquire(accelerator, `browser:${accelerator}`)
  if (!lease) {
    host.registrationStates.set(accelerator, 'conflict')
    return false
  }
  host.ownershipLeases.set(accelerator, lease)
  // 包装回调：加入 200ms 去重窗口（与内置热键 register() 一致）。
  // 浏览器快捷键同时走 globalShortcut 主路径 + uiohook 兜底，若不包 trigger()，
  // 同一次按键会被两路各触发一次 → toggleBrowserWindow 连续开关（闪一下关闭）
  // 或在窗口入映射前各开一个（同应用多窗口）。
  const throttledCallback = () => {
    if (host.registered.get(accelerator) !== throttledCallback && host.browserShortcuts.get(accelerator) !== throttledCallback) return
    host.trigger(accelerator, callback)
  }
  host.browserShortcuts.set(accelerator, throttledCallback)
  // 加入 uiohook 匹配器（兜底），复用主映射机制
  if (!host.uiohookMatchers.has(accelerator)) {
    host.uiohookMatchers.set(accelerator, {
      ...parseAccelerator(accelerator),
      callback: throttledCallback,
    })
  }
  host.ensureUiohookStarted()
  if (host._paused || host._recordingCallback) {
    host.registrationStates.set(accelerator, 'registered')
    return true
  }
  // Register with the operating system.
  try {
    const ok = globalShortcut.register(accelerator, throttledCallback)
    if (ok) {
      host.registrationStates.set(accelerator, 'registered')
      console.log(`[HotkeyManager] 浏览器全局快捷键注册成功: ${accelerator}`)
      return true
    }
    console.warn(
      `[HotkeyManager] 浏览器全局快捷键注册失败: ${accelerator}，已启用 uiohook 兜底`,
    )
  } catch (err) {
    console.warn(`[HotkeyManager] 浏览器全局快捷键注册异常: ${accelerator}`, err)
    unregisterBrowserShortcut(host, accelerator)
    host.registrationStates.set(accelerator, 'unavailable')
    return false
  }
  if (host.uiohookStarted && parseAccelerator(accelerator).keycode != null) {
    host.registrationStates.set(accelerator, 'fallback')
    return true
  }
  unregisterBrowserShortcut(host, accelerator)
  host.registrationStates.set(accelerator, 'unavailable')
  return false
}

/** 注销浏览器窗口全局快捷键 */
export function unregisterBrowserShortcut(host: BrowserShortcutsHost, accelerator: string): void {
  if (!host.browserShortcuts.has(accelerator)) return
  try {
    globalShortcut.unregister(accelerator)
  } catch (err) {
    console.warn(`[HotkeyManager] 注销浏览器全局快捷键异常: ${accelerator}`, err)
  }
  host.browserShortcuts.delete(accelerator)
  // 仅当内置热键主映射未使用该 accelerator 时才清理 uiohook 匹配器
  if (!host.registered.has(accelerator)) {
    host.uiohookMatchers.delete(accelerator)
  }
  host.lastTriggeredAt.delete(accelerator)
  host.ownershipLeases.get(accelerator)?.release()
  host.ownershipLeases.delete(accelerator)
  host.registrationStates.delete(accelerator)
}

/**
 * 注销全部浏览器窗口全局快捷键（reregisterProfileShortcuts 调用前置清理）。
 * 遍历 browserShortcuts 映射逐条注销，避免影响内置热键 registered 映射。
 */
export function unregisterAllBrowserShortcuts(host: BrowserShortcutsHost): void {
  for (const accelerator of Array.from(host.browserShortcuts.keys())) {
    unregisterBrowserShortcut(host, accelerator)
  }
}
