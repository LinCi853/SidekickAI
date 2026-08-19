// electron/utils/browser-hotkey-fallback.ts — 浏览器窗口快捷键 uiohook 兜底通道
//
// 背景：guest webContents 的 before-input-event 对 Alt 组合键（Alt+P、
// Ctrl+Alt+C）的修饰键转发在 Windows 上不可靠（Alt 可能被系统消费），
// 全屏状态下 guest 拦截也可能失效——导致「云电脑快捷键无法进入/退出、
// F11 全屏无法退出」。uiohook 是系统级键盘钩子，自行跟踪修饰键状态，
// 不受上述问题影响，作为第二通道兜底。
//
// 双通道去重：guest 通道（helpers.ts）与 uiohook 通道共用 tryForward，
// 同一 action 250ms 内仅放行一次（先到者生效），避免 toggle 类动作被
// 双触发（开了又关）。

/** 最近转发时间（action → 时间戳） */
const lastForwardedAt = new Map<string, number>()

/**
 * 转发去重闸门：同一 action 250ms 内仅放行一次。
 * @returns true=本次可转发；false=250ms 内已转发过（另一通道刚触发）
 */
export function tryForward(action: string): boolean {
  const now = Date.now()
  const last = lastForwardedAt.get(action) ?? 0
  if (now - last < 250) return false
  lastForwardedAt.set(action, now)
  return true
}

/** uiohook 按键回调（keycode 为 Windows 虚拟键码） */
export type BrowserHotkeyFallbackEvent = {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

let fallbackCallback: ((e: BrowserHotkeyFallbackEvent) => void) | null = null

/** main.ts 注册 uiohook 兜底回调（HotkeyManager uiohook keydown 时调用） */
export function setBrowserHotkeyFallback(
  cb: ((e: BrowserHotkeyFallbackEvent) => void) | null,
): void {
  fallbackCallback = cb
}

/** HotkeyManager 内部调用入口 */
export function dispatchBrowserHotkeyFallback(e: BrowserHotkeyFallbackEvent): void {
  fallbackCallback?.(e)
}

/** Windows 虚拟键码 */
export const VK_F11 = 122
export const VK_C = 67
export const VK_P = 80
