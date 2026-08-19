// electron/modules/effect-scope.ts — 可撤销副作用作用域
//
// 统一管理模块的所有副作用（IPC、热键、窗口、webview 注入、Debugger、
// 事件订阅、定时器等），模块 teardown 时一次性撤销全部。
//
// 设计：EffectScope 是 IpcScope 的超集，内部委托 IpcScope 处理 IPC 通道，
// 同时扩展管理其他 EffectKind。现有 wiring 代码可逐步迁移，不改签名。

import { ipcMain, globalShortcut, type BrowserWindow } from 'electron'

// ==================== 类型定义 ====================

/** 副作用类型枚举（re-export from shared types） */
export type { EffectKind } from '../shared/module-manifest.types.js'
import type { EffectKind } from '../shared/module-manifest.types.js'

/** 可撤销副作用句柄 */
export interface EffectHandle {
  /** 所属模块 id */
  readonly ownerModule: string
  /** 能力唯一标识，如 'freeze.debugger' */
  readonly capabilityId: string
  /** 目标标识（窗口 id / tab id / webview id），全局级为空 */
  readonly targetId?: string
  /** 副作用类型 */
  readonly kind: EffectKind
  /** 撤销此副作用（幂等） */
  dispose(): void | Promise<void>
}

// ==================== 内部实现 ====================

/** EffectHandle 内部构造参数 */
interface EffectHandleInternal {
  ownerModule: string
  capabilityId: string
  targetId?: string
  kind: EffectKind
  disposeFn: () => void | Promise<void>
}

/** 创建 EffectHandle 实例 */
function createEffectHandle(params: EffectHandleInternal): EffectHandle {
  let disposed = false
  return {
    ownerModule: params.ownerModule,
    capabilityId: params.capabilityId,
    targetId: params.targetId,
    kind: params.kind,
    dispose() {
      if (disposed) return
      disposed = true
      return params.disposeFn()
    },
  }
}

// ==================== EffectScope ====================

/**
 * 模块级副作用作用域。
 *
 * 每个模块的 wiring 持有自己的 EffectScope：init 时通过 scope 的各种
 * 快捷方法注册副作用，teardown 时调用 scope.dispose() 统一撤销。
 *
 * 与 IpcScope 的关系：EffectScope 内部使用 IpcScope 的 dispose 逻辑
 * （removeHandler + removeAllListeners），同时扩展管理其他 EffectKind。
 */
export class EffectScope {
  readonly label: string
  readonly ownerModule: string

  /** 所有已登记的副作用句柄 */
  private handles = new Set<EffectHandle>()
  /** IPC 通道集合（兼容 IpcScope 行为） */
  private readonly ipcChannels = new Set<string>()
  /** 定时器 id 集合 */
  private readonly timerIds = new Set<ReturnType<typeof setTimeout>>()

  constructor(label: string, ownerModule?: string) {
    this.label = label
    this.ownerModule = ownerModule ?? label
  }

  // ==================== 通用登记 ====================

  /** 登记一个已创建的副作用句柄（幂等） */
  track(handle: EffectHandle): void {
    this.handles.add(handle)
  }

  /** 创建并登记一个副作用句柄 */
  create(
    kind: EffectKind,
    capabilityId: string,
    disposeFn: () => void | Promise<void>,
    targetId?: string,
  ): EffectHandle {
    const handle = createEffectHandle({
      ownerModule: this.ownerModule,
      capabilityId,
      targetId,
      kind,
      disposeFn,
    })
    this.handles.add(handle)
    return handle
  }

  // ==================== IPC 快捷方法（兼容 IpcScope） ====================

  /** 登记 IPC 通道（供 dispose 卸载；重复登记幂等） */
  trackIpc(...channels: string[]): void {
    for (const ch of channels) this.ipcChannels.add(ch)
  }

  /** 直接经作用域注册 handle（天然可卸载） */
  ipcHandle(channel: string, fn: Parameters<typeof ipcMain.handle>[1]): void {
    ipcMain.handle(channel, fn)
    this.ipcChannels.add(channel)
  }

  /** 直接经作用域注册 on（天然可卸载） */
  ipcOn(channel: string, fn: Parameters<typeof ipcMain.on>[1]): void {
    ipcMain.on(channel, fn)
    this.ipcChannels.add(channel)
  }

  // ==================== 定时器快捷方法 ====================

  /** 注册定时器（自动追踪，dispose 时清除） */
  managedSetTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timerIds.delete(id)
      fn()
    }, ms)
    this.timerIds.add(id)
    return id
  }

  /** 注册定时器（自动追踪，dispose 时清除） */
  managedSetInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms)
    this.timerIds.add(id as unknown as ReturnType<typeof setTimeout>)
    return id as unknown as ReturnType<typeof setTimeout>
  }

  // ==================== 统一撤销 ====================

  /**
   * 卸载全部副作用（幂等）：
   * 1. 撤销所有 EffectHandle（按注册顺序逆序）
   * 2. 卸载所有 IPC 通道（removeHandler + removeAllListeners）
   * 3. 清除所有定时器
   */
  async dispose(): Promise<void> {
    // 1. 撤销 EffectHandle（逆序，模拟栈行为）
    const handleArray = [...this.handles].reverse()
    this.handles.clear()
    for (const handle of handleArray) {
      try {
        await handle.dispose()
      } catch (err) {
        console.warn(`[effect-scope:${this.label}] 撤销 ${handle.kind} 副作用失败:`, err)
      }
    }

    // 2. 卸载 IPC 通道
    const ipcCount = this.ipcChannels.size
    for (const ch of this.ipcChannels) {
      ipcMain.removeHandler(ch)
      ipcMain.removeAllListeners(ch)
    }
    this.ipcChannels.clear()

    // 3. 清除定时器
    for (const id of this.timerIds) {
      clearTimeout(id)
    }
    const timerCount = this.timerIds.size
    this.timerIds.clear()

    const total = handleArray.length + ipcCount + timerCount
    console.log(`[effect-scope:${this.label}] 已卸载 ${total} 个副作用 (handles=${handleArray.length}, ipc=${ipcCount}, timers=${timerCount})`)
  }

  // ==================== 查询 ====================

  /** 当前已登记的句柄数 */
  get size(): number {
    return this.handles.size + this.ipcChannels.size + this.timerIds.size
  }

  /** 按模块过滤句柄 */
  getHandlesByModule(moduleId: string): EffectHandle[] {
    return [...this.handles].filter((h) => h.ownerModule === moduleId)
  }

  /** 按 kind 过滤句柄 */
  getHandlesByKind(kind: EffectKind): EffectHandle[] {
    return [...this.handles].filter((h) => h.kind === kind)
  }
}
