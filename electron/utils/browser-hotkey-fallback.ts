import { UiohookKey } from '../hotkey/uiohook.js'

/** Guest and hook events share a gate owned by the host webContents. */
const lastForwardedAt = new WeakMap<object, Map<string, number>>()

export function tryForward(action: string, host: object): boolean {
  const now = Date.now()
  let actions = lastForwardedAt.get(host)
  if (!actions) {
    actions = new Map()
    lastForwardedAt.set(host, actions)
  }
  const last = actions.get(action)
  if (last != null && now - last < 250) return false
  actions.set(action, now)
  return true
}

/** The hook reports its own scan-code enum on every supported platform. */
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

export function matchBrowserHotkeyFallback(event: BrowserHotkeyFallbackEvent): 'toggleCloudPc' | 'toggleFullscreen' | null {
  if (event.shift || event.meta) return null
  if (event.keycode === UiohookKey.C && event.ctrl && event.alt) return 'toggleCloudPc'
  if (event.keycode === UiohookKey.F11 && !event.ctrl && !event.alt) return 'toggleFullscreen'
  return null
}
