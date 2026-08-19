// electron/modules/wiring/hotkey-sync.ts — 模块 → 热键自动同步（决策反馈：快捷键自动取消）
//
// 目标：模块关闭后，其所属快捷键自动注销（11.10「热键未注册」），再开启时自动恢复。
// 覆盖：
//   - Alt+Q（toggleDetachedWindows）：进阶面板无可用 tab（自定义对话/白板/笔记全关）时注销
//   - 每应用浏览器窗口快捷键：浏览器模块关闭时全部注销
//   - 语音 Alt+V：由 wiring/voice.syncVoiceHotkeyRegistration 负责
//
// 避免循环依赖：可用性判断与回调均通过注入函数提供（由 hotkey-ipc 注入，其已依赖 registry）。

import { getHotkeyManagerInstance } from '../../hotkey/manager.js'

/** 进阶面板可用性判断（hotkey-ipc 注入：任一 tab 模块启用即 true） */
let advancedPanelAvailable: () => boolean = () => true
/** Alt+Q 回调（hotkey-ipc 注入：toggleAdvancedPanelWindow） */
let advancedPanelCallback: (() => void) | null = null
/** 浏览器模块可用性判断（hotkey-ipc 注入） */
let browserAvailable: () => boolean = () => true

export function setAdvancedPanelAvailability(fn: () => boolean): void {
  advancedPanelAvailable = fn
}
export function setAdvancedPanelCallback(cb: () => void | null): void {
  advancedPanelCallback = cb
}
export function setBrowserAvailability(fn: () => boolean): void {
  browserAvailable = fn
}

/** 同步 Alt+Q：面板无可用 tab 时注销；有可用 tab 且开关开启且未注册时注册（幂等） */
export function syncAdvancedPanelHotkey(): void {
  const hm = getHotkeyManagerInstance()
  if (!hm) return
  const acc = hm.getActionAccelerator('toggleDetachedWindows')
  if (!advancedPanelAvailable()) {
    if (hm.isRegistered(acc)) {
      hm.unregister(acc)
      console.log('[hotkey-sync] 进阶面板无可用模块，Alt+Q 已注销')
    }
    return
  }
  if (hm.getEnabled('toggleDetachedWindows') && !hm.isRegistered(acc) && advancedPanelCallback) {
    hm.register(acc, advancedPanelCallback)
    hm.recordActionAccelerator('toggleDetachedWindows', acc)
    console.log('[hotkey-sync] Alt+Q 已恢复注册')
  }
}

/** 同步浏览器每应用快捷键：浏览器模块关闭时全部注销；启用时重注册 */
export async function syncBrowserProfileShortcuts(): Promise<void> {
  const hm = getHotkeyManagerInstance()
  if (!hm) return
  if (!browserAvailable()) {
    hm.unregisterAllBrowserShortcuts()
    console.log('[hotkey-sync] 浏览器模块关闭，每应用浏览器快捷键已全部注销')
    return
  }
  const { reregisterProfileShortcuts } = await import('../../store/app-settings-store.js')
  await reregisterProfileShortcuts()
}
