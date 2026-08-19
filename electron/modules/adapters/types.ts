// electron/modules/adapters/types.ts — TargetAdapter 接口定义
//
// 每种 EffectKind 对应一个 TargetAdapter，负责该类型副作用的注册和撤销。
// 所有 adapter 实现统一接口，由 InjectionBroker 路由调用。

import type { EffectHandle, EffectKind, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

/**
 * 目标适配器接口。
 *
 * 每种副作用类型（IPC、热键、窗口、webview 注入等）实现此接口。
 * adapter 的职责：
 *   - apply(): 注册副作用，返回 EffectHandle
 *   - revoke(): 撤销指定句柄（由 handle.dispose() 内部调用）
 */
export interface TargetAdapter {
  /** 此适配器处理的副作用类型 */
  readonly kind: EffectKind

  /**
   * 注册副作用。
   * @param request 注入请求（含 payload）
   * @param scope 所属模块的 EffectScope
   * @returns 可撤销的 EffectHandle
   */
  apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle>
}

// ==================== 各 adapter 的 payload 类型 ====================

/** IPC adapter payload */
export interface IpcPayload {
  /** IPC 通道名 */
  channel: string
  /** handler 函数（handle 模式） */
  handler?: (...args: unknown[]) => unknown
  /** 监听器函数（on 模式） */
  listener?: (...args: unknown[]) => void
  /** 模式：handle（请求-响应）或 on（事件监听） */
  mode: 'handle' | 'on'
}

/** 热键 adapter payload */
export interface HotkeyPayload {
  /** 快捷键（如 'Alt+V'） */
  accelerator: string
  /** 回调函数 */
  callback: () => void
  /** 是否使用 hotkey manager（而非 globalShortcut 直接注册） */
  useManager?: boolean
  /** hotkey manager 的 action 名（useManager=true 时必填） */
  actionName?: string
}

/** 窗口 adapter payload */
export interface WindowPayload {
  /** 窗口实例（已创建的 BrowserWindow） */
  window: Electron.BrowserWindow
  /** 窗口用途标签 */
  label?: string
}

/** webview 脚本注入 adapter payload */
export interface WebviewScriptPayload {
  /** 目标 webContents */
  webContents: Electron.WebContents
  /** 要注入的脚本 */
  script: string
  /** 是否在每次页面加载后重新注入 */
  reinjectOnNavigation?: boolean
}

/** webview CSS 注入 adapter payload */
export interface WebviewCssPayload {
  /** 目标 webContents */
  webContents: Electron.WebContents
  /** 要注入的 CSS */
  css: string
  /** 是否在每次页面加载后重新注入 */
  reinjectOnNavigation?: boolean
}

/** Debugger adapter payload */
export interface DebuggerPayload {
  /** 目标 webContents */
  webContents: Electron.WebContents
  /** CDP 版本 */
  protocolVersion?: string
  /** attach 后是否立即 pause */
  pauseAfterAttach?: boolean
}

/** 事件订阅 adapter payload */
export interface EventSubPayload {
  /** 事件发射器 */
  emitter: NodeJS.EventEmitter
  /** 事件名 */
  event: string
  /** 监听器 */
  listener: (...args: unknown[]) => void
  /** 是否使用 once */
  once?: boolean
}

/** 定时器 adapter payload */
export interface TimerPayload {
  /** 回调函数 */
  fn: () => void
  /** 间隔毫秒 */
  ms: number
  /** 类型 */
  type: 'timeout' | 'interval'
}

/** 渲染层 UI adapter payload */
export interface RendererUiPayload {
  /** UI 组件标识 */
  componentId: string
  /** 目标窗口的 webContents */
  webContents: Electron.WebContents
  /** 注册消息（通过 webContents.send 发送） */
  registerMessage: { channel: string; data: unknown }
  /** 注销消息（可选） */
  unregisterMessage?: { channel: string; data: unknown }
}
