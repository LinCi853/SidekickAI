// electron/modules/adapters/index.ts — 适配器统一导出
//
// 所有 TargetAdapter 的统一入口，方便 main.ts 初始化时批量注册。

export type { TargetAdapter } from './types.js'
export type {
  IpcPayload,
  HotkeyPayload,
  WindowPayload,
  WebviewScriptPayload,
  WebviewCssPayload,
  DebuggerPayload,
  EventSubPayload,
  TimerPayload,
  RendererUiPayload,
} from './types.js'

export { ipcAdapter } from './ipc-adapter.js'
export { hotkeyAdapter } from './hotkey-adapter.js'
export { windowAdapter } from './window-adapter.js'
export { webviewScriptAdapter } from './webview-script-adapter.js'
export { webviewCssAdapter } from './webview-css-adapter.js'
export { debuggerAdapter } from './debugger-adapter.js'
export { eventSubAdapter } from './event-sub-adapter.js'
export { timerAdapter } from './timer-adapter.js'
export { rendererUiAdapter } from './renderer-ui-adapter.js'

import { ipcAdapter } from './ipc-adapter.js'
import { hotkeyAdapter } from './hotkey-adapter.js'
import { windowAdapter } from './window-adapter.js'
import { webviewScriptAdapter } from './webview-script-adapter.js'
import { webviewCssAdapter } from './webview-css-adapter.js'
import { debuggerAdapter } from './debugger-adapter.js'
import { eventSubAdapter } from './event-sub-adapter.js'
import { timerAdapter } from './timer-adapter.js'
import { rendererUiAdapter } from './renderer-ui-adapter.js'
import type { TargetAdapter } from './types.js'

/** 全部适配器列表（供 InjectionBroker.registerAdapters 使用） */
export const allAdapters: TargetAdapter[] = [
  ipcAdapter,
  hotkeyAdapter,
  windowAdapter,
  webviewScriptAdapter,
  webviewCssAdapter,
  debuggerAdapter,
  eventSubAdapter,
  timerAdapter,
  rendererUiAdapter,
]
