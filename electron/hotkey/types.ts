// electron/hotkey/types.ts — 热键相关类型定义

/** 内置热键动作标识 */
export type HotkeyAction =
  | 'toggleMainWindow'
  | 'toggleDetachedWindows'
  | 'backgroundVoice'
  | 'toggleVoice'

/** 热键录制回调（主进程 → 渲染层：录制完成后通知） */
export type HotkeyRecordingCallback = (result: { accelerator: string; reason?: string }) => void

/** 热键录制实时反馈回调（每次按键时通知，用于 UI 实时显示当前组合） */
export type HotkeyPartialCallback = (partial: { modifiers: string[]; key: string | null }) => void

/** 热键配置（用于 UI 展示与持久化） */
export interface HotkeyConfig {
  action: HotkeyAction
  /** 显示名称 */
  label: string
  /** accelerator 字符串 */
  accelerator: string
  /** 是否启用（false 时热键不注册、不响应） */
  enabled: boolean
}

/** uiohook-napi 键盘事件 */
export interface UiohookEvent {
  type: number
  keycode: number
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** uiohook-napi 模块接口 */
export interface UiohookModule {
  UiohookKey: Record<string, number>
  EventType: { EVENT_KEY_PRESSED: number; EVENT_KEY_RELEASED: number }
  uIOhook: {
    start(): void
    stop(): void
    on(event: string, cb: (e: UiohookEvent) => void): void
  }
}
