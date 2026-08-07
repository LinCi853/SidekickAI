// electron/window-factory/window-maximize-manager.ts — 窗口最大化/还原统一管理组件
//
// 将「记录最大化前尺寸」「最大化」「取消最大化还原」三步抽象为可配置的统一组件，
// 所有窗口（主窗口 / 浏览器窗口 / 独立窗口 / Chat 窗口 / 进阶面板窗口）按需采用，
// 保证实现效果统一。
//
// 核心能力：
//   1. 记录 normalBounds（进入最大化前的窗口尺寸/位置）
//   2. 最大化：setBounds 到工作区全屏
//   3. 取消最大化：按 restoreStrategy 还原
//      - 'normalBounds'：还原到进入最大化前的尺寸（主窗口 / 独立窗口 / Chat 窗口）
//      - 'centered70'：还原为工作区居中、占 70% 尺寸，保持 normalBounds 宽高比（浏览器窗口）
//      - 'defaultSize'：还原到预设默认尺寸并居中（可传 defaultBounds）
//   4. 最大化与置顶互斥：进入最大化时自动取消置顶
//   5. 通过 IPC 通知渲染层状态变化

import { screen, type BrowserWindow } from 'electron'
import { windowStore } from '../store/window-store.js'
import { browserWindowStore } from '../store/browser-window-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { ADVANCED_PANEL_WINDOW_ID } from './helpers.js'

/** 窗口尺寸（位置 + 大小） */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

/** 取消最大化的还原策略 */
export type RestoreStrategy =
  | 'normalBounds'   // 还原到进入最大化前的尺寸（主窗口 / 独立窗口 / Chat 窗口）
  | 'centered70'     // 固定还原为工作区居中、占 70% 尺寸（浏览器窗口）
  | 'defaultSize'    // 还原到预设默认尺寸并居中

/** WindowMaximizeManager 配置 */
export interface MaximizeManagerOptions {
  /** 窗口 id（'main' 或 UUID） */
  windowId: string
  /** 还原策略，默认 'normalBounds' */
  restoreStrategy?: RestoreStrategy
  /** restoreStrategy='defaultSize' 时使用的默认尺寸（居中放置） */
  defaultBounds?: WindowBounds
}

/**
 * 窗口最大化/还原统一管理器。
 *
 * 使用方式：
 *   const mgr = new WindowMaximizeManager(win, { windowId: 'main' })
 *   mgr.toggle()           // 切换最大化/还原
 *   mgr.maximize()         // 最大化
 *   mgr.unmaximize()       // 取消最大化（按策略还原）
 *   mgr.isMaximized()      // 当前是否最大化
 *
 * 浏览器窗口示例：
 *   const mgr = new WindowMaximizeManager(win, { windowId, restoreStrategy: 'centered70' })
 */
export class WindowMaximizeManager {
  private win: BrowserWindow
  private windowId: string
  private restoreStrategy: RestoreStrategy
  private defaultBounds?: WindowBounds

  constructor(win: BrowserWindow, options: MaximizeManagerOptions) {
    this.win = win
    this.windowId = options.windowId
    this.restoreStrategy = options.restoreStrategy ?? 'normalBounds'
    this.defaultBounds = options.defaultBounds
  }

  /** 当前是否最大化（从持久化状态读取，与 toggleMaximizeForWindow 保持一致） */
  isMaximized(): boolean {
    return windowStore.getOrDefault(this.windowId).isMaximized
  }

  /**
   * 切换最大化/还原状态。
   * @returns 切换后的最大化状态
   */
  toggle(): boolean {
    if (this.isMaximized()) {
      this.unmaximize()
      return false
    }
    this.maximize()
    return true
  }

  /**
   * 最大化窗口：
   *   1. 记录当前 bounds 为 normalBounds（供还原使用）
   *   2. setBounds 到工作区全屏
   *   3. 自动取消置顶（互斥关系）
   *   4. 通知渲染层
   */
  maximize(): void {
    const state = windowStore.getOrDefault(this.windowId)
    if (state.isMaximized) return

    const currentBounds = this.win.getBounds()
    state.normalBounds = { ...currentBounds }
    state.bounds = { ...currentBounds }

    // 先调用 win.maximize() 同步原生最大化标记
    // 这会触发 setupMaximizeSync/setupBoundsTracking 的 'maximize' 事件监听器，
    // 监听器会设置 state.isMaximized = true（和 normalBounds，如果是 setupBoundsTracking）。
    // 然后用 setBounds() 覆盖尺寸到工作区全屏（win.maximize() 的原生尺寸可能不精确）。
    try {
      this.win.maximize()
    } catch (err) {
      console.error(`[maximize:${this.windowId}] win.maximize() 失败:`, err)
    }

    const display = screen.getDisplayMatching(currentBounds)
    const workArea = display.workArea
    try {
      this.win.setBounds({
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height,
      })
      console.log(`[maximize:${this.windowId}] 最大化到工作区:`, workArea.width, 'x', workArea.height)
    } catch (err) {
      console.error(`[maximize:${this.windowId}] setBounds 失败:`, err)
    }

    state.isMaximized = true

    // 最大化与置顶互斥：进入最大化时自动取消置顶
    if (state.alwaysOnTop) {
      state.alwaysOnTop = false
      try {
        this.win.setAlwaysOnTop(false)
      } catch { /* ignore */ }
      this.notifyPinToggled(false)
      console.log(`[maximize:${this.windowId}] 最大化时自动取消置顶`)
    }

    windowStore.save(this.windowId, state)
    this.notifyMaximizeToggled(true)
  }

  /**
   * 取消最大化：按 restoreStrategy 还原窗口尺寸。
   *   - 'normalBounds'：还原到进入最大化前的 normalBounds
   *   - 'centered70'：固定还原为工作区居中、占 70% 尺寸的窗口
   *   - 'defaultSize'：还原到预设默认尺寸并居中
   */
  unmaximize(): void {
    const state = windowStore.getOrDefault(this.windowId)
    if (!state.isMaximized) return

    // 先更新状态，再同步原生标记
    // win.unmaximize() 会触发 setupMaximizeSync/setupBoundsTracking 的 'unmaximize' 事件监听器，
    // 该监听器检查 if (state.isMaximized) — 由于我们先将 state.isMaximized 设为 false，
    // 监听器会跳过处理（是 no-op），避免重复更新状态。
    state.isMaximized = false
    state.normalBounds = undefined

    // 先调用 win.unmaximize() 清除原生最大化标记
    // 这会恢复窗口到 maximize() 之前的原生尺寸，但我们将用 setBounds() 覆盖
    try {
      this.win.unmaximize()
    } catch (err) {
      console.error(`[maximize:${this.windowId}] win.unmaximize() 失败:`, err)
    }

    // 按 restoreStrategy 计算并应用自定义还原尺寸
    const restored = this.computeRestoredBounds(state.normalBounds)
    if (restored) {
      try {
        this.win.setBounds(restored)
        console.log(`[maximize:${this.windowId}] 还原:`, this.restoreStrategy, restored.width, 'x', restored.height)
      } catch (err) {
        console.error(`[maximize:${this.windowId}] 还原 setBounds 失败:`, err)
      }
      state.bounds = { ...restored }
    }

    windowStore.save(this.windowId, state)
    this.notifyMaximizeToggled(false)
  }

  /**
   * 根据还原策略计算取消最大化后的目标尺寸。
   */
  private computeRestoredBounds(normalBounds?: WindowBounds): WindowBounds | null {
    const display = screen.getDisplayMatching(this.win.getBounds())
    const workArea = display.workArea

    switch (this.restoreStrategy) {
      case 'centered70': {
        // 固定还原为工作区居中、占 70% 尺寸的窗口（不保留 normalBounds 宽高比）
        const tW = Math.round(workArea.width * 0.7)
        const tH = Math.round(workArea.height * 0.7)
        return {
          x: Math.round(workArea.x + (workArea.width - tW) / 2),
          y: Math.round(workArea.y + (workArea.height - tH) / 2),
          width: tW,
          height: tH,
        }
      }
      case 'defaultSize': {
        // 预设默认尺寸并居中
        const def = this.defaultBounds
        if (!def) return normalBounds ?? null
        return {
          x: Math.round(workArea.x + (workArea.width - def.width) / 2),
          y: Math.round(workArea.y + (workArea.height - def.height) / 2),
          width: def.width,
          height: def.height,
        }
      }
      case 'normalBounds':
      default: {
        // 还原到进入最大化前的 normalBounds
        const restore = normalBounds ?? windowStore.getOrDefault(this.windowId).bounds
        return restore ? { ...restore } : null
      }
    }
  }

  /** 通知渲染层最大化状态变化 */
  private notifyMaximizeToggled(maximized: boolean): void {
    if (!this.win.isDestroyed()) {
      try {
        this.win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, maximized)
      } catch { /* ignore */ }
    }
  }

  /** 通知渲染层置顶状态变化 */
  private notifyPinToggled(pinned: boolean): void {
    if (!this.win.isDestroyed()) {
      try {
        this.win.webContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, pinned)
      } catch { /* ignore */ }
    }
  }
}

/**
 * 根据窗口 id 自动选择合适的还原策略。
 *
 * 浏览器窗口 / 进阶面板窗口 → 'centered70'（工作区居中 70% 尺寸）
 * 其他窗口（主窗口 / 独立窗口 / Chat 窗口）→ 'normalBounds'（还原到进入最大化前的尺寸）
 *
 * 用于 toggleMaximizeForWindow 等通用入口，无需调用方手动判断窗口类型。
 */
export function inferRestoreStrategy(windowId: string): RestoreStrategy {
  // 浏览器窗口的持久化状态在 browserWindowStore 中
  if (browserWindowStore.get(windowId) !== null) {
    return 'centered70'
  }
  // 进阶面板窗口：与浏览器窗口同步，取消最大化时还原为工作区居中 70%
  if (windowId === ADVANCED_PANEL_WINDOW_ID) {
    return 'centered70'
  }
  return 'normalBounds'
}

/**
 * 创建 WindowMaximizeManager 的便捷工厂函数。
 * 自动根据窗口 id 推断还原策略。
 */
export function createMaximizeManager(
  win: BrowserWindow,
  windowId: string,
  options?: Partial<Omit<MaximizeManagerOptions, 'windowId'>>,
): WindowMaximizeManager {
  const restoreStrategy = options?.restoreStrategy ?? inferRestoreStrategy(windowId)
  return new WindowMaximizeManager(win, {
    windowId,
    restoreStrategy,
    defaultBounds: options?.defaultBounds,
  })
}
