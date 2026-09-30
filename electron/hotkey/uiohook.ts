// electron/hotkey/uiohook.ts — uiohook-napi 动态加载

import { createRequire } from 'module'
import type { UiohookEvent, UiohookModule } from './types.js'

/**
 * uiohook-napi 动态加载（已移到 optionalDependencies）。
 *
 * 背景：uiohook-napi 在 macOS / Linux 上需要 Xcode CLT / build-essential 才能编译，
 * 编译失败时 npm install 不会中断（optionalDependencies 语义），但运行时静态 import
 * 会让整个 manager.ts 崩溃。改用 createRequire 动态 require，失败时降级到 mock，
 * HotkeyManager 仅依赖 Electron globalShortcut（系统级注册仍可用，低层钩子兜底失效）。
 *
 * 可用性必须如实暴露（getUiohookAvailability）：mock 的 start() 不会抛错，
 * 若调用方据此把钩子标记为"已启动"，会导致系统热键回调被输入状态门禁误杀
 * （钩子永远观察不到物理按键 → claim 永远失败 → 热键全哑）。
 */
let loadError: string | null = null

function loadUiohook(): UiohookModule | null {
  try {
    const require = createRequire(__filename)
    return require('uiohook-napi') as UiohookModule
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    console.warn(
      '[HotkeyManager] ⚠️ 降级实现: uiohook-napi 加载失败，降级到仅 globalShortcut（低层钩子兜底不可用）:',
      err,
    )
    return null
  }
}

const uiohookMod = loadUiohook()

/** 原生键盘钩子是否真实可用（模块加载成功）；不可用时携带失败原因 */
export function getUiohookAvailability(): { available: boolean; error: string | null } {
  return { available: uiohookMod !== null, error: loadError }
}
export const UiohookKey: Record<string, number> = uiohookMod?.UiohookKey ?? {}
export const EventType = uiohookMod?.EventType ?? { EVENT_KEY_PRESSED: 1, EVENT_KEY_RELEASED: 2 }
export const uIOhook = uiohookMod?.uIOhook ?? {
  start() { /* no-op: uiohook 不可用 */ },
  stop() { /* no-op */ },
  on(_event: string, _cb: (e: UiohookEvent) => void) { /* no-op */ },
}
