// electron/ipc/window-control-ipc.ts — 窗口控制相关 IPC 注册
//
// 包含：
//   - 自定义对话窗口（CHAT_OPEN_WINDOW / CHAT_OPEN_HISTORY_WINDOW）
//   - chat 脱离窗口管理（CHAT_LIST/CREATE/UPDATE/REMOVE/SHOW_DETACHED/GET_CONFIG）
//   - Profile 级窗口管理（WINDOW_OPEN/CLOSE/CLOSE_ALL/SWITCH_UA/SWITCH_DEVICE/SET_ALWAYS_ON_TOP/GET_OPEN_IDS/SETUP_SESSION）
//   - 指纹脚本（FINGERPRINT_GET_SCRIPT）
//   - 当前窗口控制（WIN_CONTROL_MINIMIZE/MAXIMIZE_TOGGLE/CLOSE/SET_ALWAYS_ON_TOP/IS_MAXIMIZED/GET_BOUNDS/RESIZE/TOGGLE_FULLSCREEN）
//   - 窗口状态持久化（WIN_STATE_GET/SAVE/LIST_DETACHED/REMOVE）
//
// 在 app.whenReady 后由 main.ts 调用 registerWindowControlIpc(deps) 完成注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { windowStore } from '../store/window-store.js'
import { profileStore } from '../store/profile-store.js'
import { createMaximizeManager } from '../window-factory/window-maximize-manager.js'
import {
  IPC_CHANNELS,
  type WindowStateData,
  type ChatWindowConfig,
} from '../shared/types.js'
import type { WindowManager } from '../window/manager.js'
import type { FingerprintEngine } from '../fingerprint/engine.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface WindowControlIpcDeps {
  windowManager: WindowManager
  fingerprintEngine: FingerprintEngine
  /** 获取 IPC 调用方所在的 BrowserWindow */
  getSenderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null
  /** 通过 BrowserWindow 实例反查 windowId */
  findWindowIdByWin: (win: BrowserWindow) => string | null
  /** 创建自定义对话窗口（API 直连模式，单例） */
  createChatWindow: () => BrowserWindow | null
  /** 显示历史搜索独立窗口（单例） */
  showHistoryWindow: () => void
  /** 获取脱离窗口 Map 中的窗口实例 */
  getDetachedWindow: (windowId: string) => BrowserWindow | undefined
}

/**
 * 注册窗口控制相关 IPC handler。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerWindowControlIpc(deps: WindowControlIpcDeps, scope?: EffectScope): void {
  const {
    windowManager,
    fingerprintEngine,
    getSenderWindow,
    findWindowIdByWin,
    createChatWindow,
    showHistoryWindow,
    getDetachedWindow,
  } = deps

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== 创建自定义对话窗口 IPC（旧单例） =====
  handle(IPC_CHANNELS.CHAT_OPEN_WINDOW, () => {
    createChatWindow()
  })

  // ===== 历史搜索独立窗口 IPC（单例，列举所有本地保存数据） =====
  handle(IPC_CHANNELS.CHAT_OPEN_HISTORY_WINDOW, () => {
    showHistoryWindow()
  })

  // ===== 自定义对话脱离窗口管理 IPC（已停用，保留 IPC 通道兼容旧渲染层调用） =====
  // 4.7 重构后：Alt+Q 改为切换 进阶面板（toggleAdvancedPanelWindow），
  // 不再创建/显示旧的 per-provider chat 脱离窗口（mode='chat'）。
  // 各 handler 降级为 no-op / 空返回，避免旧渲染层调用时崩溃。
  // 列出 chat 脱离窗口：始终返回空数组（不再有活跃的 chat 脱离窗口）
  handle(IPC_CHANNELS.CHAT_LIST_DETACHED, () => {
    return []
  })
  // 创建 chat 脱离窗口：已停用，返回空字符串（不再创建）
  handle(IPC_CHANNELS.CHAT_CREATE_DETACHED, () => {
    console.warn('[window-control-ipc] ⚠️ 降级实现: CHAT_CREATE_DETACHED 已停用（4.7 重构），请使用 进阶面板')
    return ''
  })
  // 更新 chat 脱离窗口配置：no-op
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_DETACHED,
    (_e, _windowId: string, _config: ChatWindowConfig) => {
      console.warn('[window-control-ipc] CHAT_UPDATE_DETACHED 已停用（4.7 重构）')
    },
  )
  // 删除 chat 脱离窗口：仅清理状态（关闭可能残留的窗口）
  ipcMain.handle(IPC_CHANNELS.CHAT_REMOVE_DETACHED, (_e, windowId: string) => {
    const w = getDetachedWindow(windowId)
    if (w && !w.isDestroyed()) {
      w.close()
    }
    windowStore.remove(windowId)
  })
  // 显示 chat 脱离窗口：已停用，no-op（不再显示旧的 per-provider chat 窗口）
  ipcMain.handle(IPC_CHANNELS.CHAT_SHOW_DETACHED, (_e, windowId: string) => {
    console.warn(`[window-control-ipc] CHAT_SHOW_DETACHED 已停用（4.7 重构），windowId=${windowId}，请使用 进阶面板`)
  })
  // 获取当前窗口的 chatConfig（ChatView 渲染时调用，保留兼容）
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_CONFIG, (_e, windowId: string) => {
    const state = windowStore.get(windowId)
    return state?.chatConfig ?? null
  })

  // ===== 窗口管理 IPC（Profile 级别）=====
  ipcMain.handle(IPC_CHANNELS.WINDOW_OPEN, async (_e, profileId: string) => {
    await windowManager.openProfile(profileId)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, async (_e, profileId: string) => {
    await windowManager.closeProfile(profileId)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE_ALL, async () => {
    await windowManager.closeAll()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_SWITCH_UA, async (_e, profileId: string, ua: string) => {
    windowManager.switchUA(profileId, ua)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_SWITCH_DEVICE, async (_e, profileId: string, presetId: string) => {
    windowManager.switchDevice(profileId, presetId)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_ALWAYS_ON_TOP, async (_e, profileId: string, onTop: boolean) => {
    windowManager.setAlwaysOnTop(profileId, onTop)
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_GET_OPEN_IDS, async () => {
    return windowManager.getOpenWindowIds()
  })
  ipcMain.handle(IPC_CHANNELS.WINDOW_SETUP_SESSION, async (_e, profileId: string) => {
    await windowManager.setupSession(profileId)
  })

  // ===== 指纹脚本 IPC =====
  ipcMain.handle(IPC_CHANNELS.FINGERPRINT_GET_SCRIPT, async (_e, profileId: string) => {
    const profile = profileStore.get(profileId)
    if (!profile) {
      throw new Error(`Profile 不存在: ${profileId}`)
    }
    return fingerprintEngine.generateScript(profile)
  })

  // ===== 窗口控制 IPC（操作调用方所在窗口本身）=====
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_MINIMIZE, (e) => {
    const win = getSenderWindow(e)
    if (!win || win.isDestroyed()) return
    win.minimize()
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLE, (e) => {
    const win = getSenderWindow(e)
    if (!win) return false
    return toggleMaximizeForWindow(win, findWindowIdByWin(win))
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_CLOSE, (e) => {
    const win = getSenderWindow(e)
    if (!win) return
    // 主窗口的 closeBehavior 由 main-window.ts 的 'close' 事件统一处理
    // （拦截 minimize 并 hide，close 则正常关闭触发 app.quit）
    // 独立窗口（提示词库/历史/chat/脱离标签/屏蔽规则）始终直接关闭
    win.close()
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_SET_ALWAYS_ON_TOP, (e, onTop: boolean) => {
    const win = getSenderWindow(e)
    if (!win) return false
    // 标记用户主动操作时间戳，防止 reapplyAlwaysOnTop 竞态覆盖
    try { (win as any).__markUserPinAction?.() } catch { /* ignore */ }
    return setAlwaysOnTopForWindow(win, findWindowIdByWin(win), onTop)
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_IS_MAXIMIZED, (e) => {
    const win = getSenderWindow(e)
    if (!win) return false
    const windowId = findWindowIdByWin(win)
    if (!windowId) return false
    return windowStore.getOrDefault(windowId).isMaximized ?? false
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_IS_ALWAYS_ON_TOP, (e) => {
    const win = getSenderWindow(e)
    if (!win || win.isDestroyed()) return false
    return win.isAlwaysOnTop()
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_GET_BOUNDS, (e) => {
    const win = getSenderWindow(e)
    if (!win) return { width: 0, height: 0 }
    return win.getBounds()
  })
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_RESIZE, (e, bounds: { x?: number; y?: number; width: number; height: number }) => {
    const win = getSenderWindow(e)
    if (!win || win.isDestroyed()) return
    try {
      // 若窗口处于最大化状态，先还原再设置 bounds，避免 setBounds 行为异常
      if (win.isMaximized()) {
        win.unmaximize()
      }
      // Clamp 到窗口的 minimumSize：setBounds 不会自动约束，
      // 需手动确保 width/height 不低于 minWidth/minHeight（UI 比例变化时 minWidth 会动态更新）
      const [minW, minH] = win.getMinimumSize()
      const clamped = {
        ...bounds,
        width: Math.max(bounds.width, minW),
        height: Math.max(bounds.height, minH),
      }
      win.setBounds(clamped)
    } catch (err) {
      console.error('[main] resize 失败:', err)
    }
  })
  // 切换全屏：进入前记录当前 bounds，退出时由 leave-full-screen 事件恢复
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_TOGGLE_FULLSCREEN, (e) => {
    const win = getSenderWindow(e)
    if (!win) return false
    if (win.isFullScreen()) {
      // 退出全屏：leave-full-screen 事件会恢复到 fullscreenNormalBounds
      win.setFullScreen(false)
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, false)
      }
      return false
    }
    // 进入全屏前：记录当前 bounds 到 fullscreenNormalBounds，供退出时精确恢复
    const windowId = findWindowIdByWin(win)
    if (windowId) {
      const state = windowStore.getOrDefault(windowId)
      state.fullscreenNormalBounds = win.getBounds()
      windowStore.save(windowId, state)
    }
    win.setFullScreen(true)
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, true)
    }
    return true
  })
  // 动态设置当前窗口的最小尺寸（UI 比例变化时重新约束）
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_SET_MIN_SIZE, (e, width: number, height: number) => {
      const win = getSenderWindow(e)
      if (!win || win.isDestroyed()) return
      try {
        win.setMinimumSize(Math.max(0, Math.floor(width)), Math.max(0, Math.floor(height)))
      } catch (err) {
        console.error('[main] setMinimumSize 失败:', err)
      }
    },
  )
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_GET_MIN_SIZE, (e) => {
    const win = getSenderWindow(e)
    if (!win || win.isDestroyed()) return { width: 0, height: 0 }
    const [width, height] = win.getMinimumSize()
    return { width, height }
  })

  // ===== 窗口状态持久化 IPC =====
  ipcMain.handle(IPC_CHANNELS.WIN_STATE_GET, (_e, windowId: string) => {
    return windowStore.get(windowId)
  })
  ipcMain.handle(IPC_CHANNELS.WIN_STATE_SAVE, (_e, windowId: string, incoming: WindowStateData) => {
    const existing = windowStore.get(windowId)
    // 最大化时保留旧 bounds，避免渲染层 persist 用全屏尺寸覆盖小窗口尺寸
    if (incoming.isMaximized && existing) {
      incoming.bounds = existing.bounds
    }
    // 渲染层 persist 不携带 normalBounds，保留主进程已保存的值，
    // 否则最大化期间任何一次 persist 都会把它擦成 undefined，导致还原时无法回到原尺寸
    if (existing?.normalBounds && incoming.normalBounds === undefined) {
      incoming.normalBounds = existing.normalBounds
    }
    windowStore.save(windowId, incoming)
  })
  ipcMain.handle(IPC_CHANNELS.WIN_STATE_LIST_DETACHED, async () => {
    return windowStore.listDetachedWindowIds()
  })
  ipcMain.handle(IPC_CHANNELS.WIN_STATE_REMOVE, (_e, windowId: string) => {
    windowStore.remove(windowId)
  })
}

// =====================================================================
// 共享窗口控制函数（供主进程其他模块调用，如 webview 快捷键拦截）
// 与 IPC handler 共用同一份逻辑，保证行为一致
// =====================================================================

/**
 * 切换指定窗口的最大化状态（复用 IPC 同一份逻辑）
 * @returns 切换后是否最大化
 */
export function toggleMaximizeForWindow(
  win: BrowserWindow,
  windowId: string | null,
): boolean {
  if (!windowId) return win.isMaximized()
  // 使用统一的最大化管理组件，自动推断还原策略：
  // 浏览器窗口 → centered70，其他窗口 → normalBounds
  const mgr = createMaximizeManager(win, windowId)
  return mgr.toggle()
}

/**
 * 设置指定窗口的置顶状态（复用 IPC 同一份逻辑）
 * 最大化/全屏状态下不允许置顶（冲突关系），返回 false。
 * @returns 实际置顶状态
 */
export function setAlwaysOnTopForWindow(
  win: BrowserWindow,
  windowId: string | null,
  onTop: boolean,
): boolean {
  // 最大化/全屏与置顶互斥：不允许在最大化/全屏时开启置顶
  if (onTop && (win.isMaximized() || win.isFullScreen())) {
    console.log('[setAlwaysOnTop] 跳过：窗口处于最大化/全屏状态，与置顶冲突')
    return false
  }
  // 如果是用户主动操作（通过 __markUserPinAction 标记），记录时间戳
  try { (win as any).__markUserPinAction?.() } catch { /* ignore */ }
  win.setAlwaysOnTop(onTop, 'screen-saver')
  const actual = win.isAlwaysOnTop()
  if (windowId) {
    const state = windowStore.getOrDefault(windowId)
    state.alwaysOnTop = actual
    windowStore.save(windowId, state)
  }
  // 每次变更都广播，确保渲染层同步（修复置顶后失焦被覆盖的竞态）
  if (!win.isDestroyed()) {
    try { win.webContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual) } catch { /* ignore */ }
  }
  return actual
}
