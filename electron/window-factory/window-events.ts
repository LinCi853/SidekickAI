// electron/window-factory/window-events.ts — 窗口生命周期事件
//
// 从 helpers.ts 抽离：bounds 持久化、maximize/alwaysOnTop 事件同步、
// 脱离窗口生命周期、窗口级 F11/F12 快捷键拦截、sender 窗口反查。

import { BrowserWindow } from 'electron'
import { windowStore } from '../store/window-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { windowState } from '../window-state.js'
import {
  setAlwaysOnTopForWindow,
  toggleMaximizeForWindow,
} from '../ipc/window-control-ipc.js'
import { safeLogWindowTrace, findWindowIdByWin } from './window-utils.js'

/** 获取调用方所在的 BrowserWindow */
export function getSenderWindow(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/**
 * 为窗口设置 maximize/unmaximize/alwaysOnTop 事件同步（不保存 bounds）。
 * 适用于浏览器窗口和进阶面板窗口：取消最大化时使用 WindowMaximizeManager
 * 的 centered70 等策略还原，不需要记忆 bounds。
 */
export function setupMaximizeSync(win: BrowserWindow, windowId: string): void {
  // 重新应用置顶（Windows 上被全屏窗口/任务栏覆盖后常见失效原因）
  // 保护：记录最近一次用户主动设置置顶的时间戳，短时间内不覆盖（避免 focus 事件竞态）
  let lastPinActionAt = 0
  // WIN_CONTROL_PIN_TOGGLED 中带 isUserAction 标记时更新时间戳
  // 本函数也接受外部调用来标记用户操作
  const markUserPinAction = () => { lastPinActionAt = Date.now() }
  // 暴露给窗口生命周期调用方（如热键、按钮）
  ;(win as any).__markUserPinAction = markUserPinAction

  const reapplyAlwaysOnTop = () => {
    if (win.isMaximized() || win.isFullScreen()) return
    // 用户主动操作后 2 秒内不自动覆盖，防止窗口 focus/restore 竞态
    if (Date.now() - lastPinActionAt < 2000) return
    const state = windowStore.getOrDefault(windowId)
    if (state.alwaysOnTop && !win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true, 'screen-saver')
    } else if (!state.alwaysOnTop && win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(false)
    }
  }
  win.on('show', reapplyAlwaysOnTop)
  win.on('focus', reapplyAlwaysOnTop)
  win.on('restore', reapplyAlwaysOnTop)

  // 最大化/全屏 → 自动取消置顶（冲突关系：两种状态不能共存）
  const cancelAlwaysOnTopOnConflict = () => {
    if (!win.isAlwaysOnTop()) return
    win.setAlwaysOnTop(false)
    const state = windowStore.getOrDefault(windowId)
    state.alwaysOnTop = false
    windowStore.save(windowId, state)
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, false)
    }
    console.log(`[helpers] 窗口 ${windowId} 进入最大化/全屏，自动取消置顶`)
  }
  win.on('maximize', cancelAlwaysOnTopOnConflict)
  win.on('enter-full-screen', cancelAlwaysOnTopOnConflict)

  // 最大化/还原事件 → 同步 state + 渲染层按钮图标
  win.on('maximize', () => {
    safeLogWindowTrace(windowId, 'maximize')
    const state = windowStore.getOrDefault(windowId)
    if (!state.isMaximized) {
      state.isMaximized = true
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, true)
    }
  })
  win.on('unmaximize', () => {
    safeLogWindowTrace(windowId, 'unmaximize')
    const state = windowStore.getOrDefault(windowId)
    if (state.isMaximized) {
      state.isMaximized = false
      state.normalBounds = undefined
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
    }
  })
  win.on('minimize', () => safeLogWindowTrace(windowId, 'minimize'))
  win.on('restore', () => safeLogWindowTrace(windowId, 'restore'))
  win.on('show', () => safeLogWindowTrace(windowId, 'show'))
  win.on('hide', () => {
    safeLogWindowTrace(windowId, 'hide')
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_HIDDEN)
    }
  })
}

/**
 * 为窗口设置 bounds 持久化（防抖保存到 windowStore）
 * 同时监听 maximize/unmaximize/show/focus 事件，
 * 若窗口应保持置顶（state.alwaysOnTop）则重新应用，
 * 避免被 Windows 全屏窗口覆盖后失效。
 */
export function setupBoundsTracking(win: BrowserWindow, windowId: string): void {
  const debouncedSave = () => {
    const existing = windowState.boundsSaveTimers.get(windowId)
    if (existing) clearTimeout(existing)
    windowState.boundsSaveTimers.set(
      windowId,
      setTimeout(() => {
        const state = windowStore.getOrDefault(windowId)
        // 仅非最大化、非全屏状态时保存 bounds，避免全屏/最大化尺寸覆盖小窗口尺寸
        if (!state.isMaximized && !win.isFullScreen()) {
          state.bounds = win.getBounds()
        }
        // isMaximized 状态由手动切换逻辑维护，这里不覆盖
        windowStore.save(windowId, state)
        windowState.boundsSaveTimers.delete(windowId)
      }, 500),
    )
  }
  win.on('resize', debouncedSave)
  win.on('move', debouncedSave)

  // 重新应用置顶（Windows 上被全屏窗口/任务栏覆盖后常见失效原因）
  // 仅在 show/focus/restore 时重新应用——maximize/fullscreen 与置顶互为冲突状态，
  // 进入时主动取消，退出时不自动恢复（用户需手动按 F12 重新置顶）。
  const reapplyAlwaysOnTop = () => {
    if (win.isMaximized() || win.isFullScreen()) return
    const state = windowStore.getOrDefault(windowId)
    if (state.alwaysOnTop && !win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true, 'screen-saver')
    } else if (!state.alwaysOnTop && win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(false)
    }
  }
  win.on('show', reapplyAlwaysOnTop)
  win.on('focus', reapplyAlwaysOnTop)
  win.on('restore', reapplyAlwaysOnTop)

  // 最大化/全屏 → 自动取消置顶（冲突关系：两种状态不能共存）
  const cancelAlwaysOnTopOnConflict = () => {
    if (!win.isAlwaysOnTop()) return
    win.setAlwaysOnTop(false)
    const state = windowStore.getOrDefault(windowId)
    state.alwaysOnTop = false
    windowStore.save(windowId, state)
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, false)
    }
    console.log(`[helpers] 窗口 ${windowId} 进入最大化/全屏，自动取消置顶`)
  }
  win.on('maximize', cancelAlwaysOnTopOnConflict)
  win.on('enter-full-screen', cancelAlwaysOnTopOnConflict)

  // 最大化/还原事件 → 同步 state + 渲染层按钮图标（统一处理，覆盖所有窗口类型）
  // OS 原生最大化（Win+Up、Aero Snap、双击标题栏）也会触发，需同步 state.isMaximized
  // 和 normalBounds，否则 state 与 win.isMaximized() 不一致，导致 bounds 持久化错误。
  // IPC 最大化由 WindowMaximizeManager 使用 setBounds 实现（不触发 'maximize' 事件），
  // 此处仅处理 OS 原生最大化，不会与 WindowMaximizeManager 冲突。
  win.on('maximize', () => {
    safeLogWindowTrace(windowId, 'maximize')
    const state = windowStore.getOrDefault(windowId)
    if (!state.isMaximized) {
      // OS 原生最大化：记录 normalBounds 供还原使用
      state.normalBounds = state.bounds
      state.isMaximized = true
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, true)
    }
  })
  win.on('unmaximize', () => {
    safeLogWindowTrace(windowId, 'unmaximize')
    const state = windowStore.getOrDefault(windowId)
    if (state.isMaximized) {
      state.isMaximized = false
      state.normalBounds = undefined
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
    }
  })
  win.on('minimize', () => safeLogWindowTrace(windowId, 'minimize'))
  win.on('restore', () => safeLogWindowTrace(windowId, 'restore'))
  win.on('show', () => safeLogWindowTrace(windowId, 'show'))
  win.on('hide', () => {
    safeLogWindowTrace(windowId, 'hide')
    // 通知渲染层窗口已隐藏，用于自动收起展开的面板（底栏等）
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_HIDDEN)
    }
  })
}

/**
 * 为脱离窗口（chat / standalone / ai-app）附加统一的生命周期管理。
 *
 * 统一处理：
 *   1. bounds 持久化追踪（setupBoundsTracking）或轻量 maximize 事件同步
 *   2. focus 追踪（更新 windowState.lastFocusedWin）
 *   3. close 事件：持久化 isMaximized/alwaysOnTop（可选保存 bounds）到 windowStore
 *   4. closed 事件：从 windowState.detachedWindows 清理 + 可选自定义清理
 *
 * @param options.trackBounds 是否追踪并保存 bounds（默认 true）。
 *   设为 false 时仅追踪 maximize/unmaximize/alwaysOnTop 事件，不保存 bounds。
 *   适用于浏览器窗口和进阶面板窗口：取消最大化时使用 WindowMaximizeManager
 *   的 centered70 策略还原，不需要记忆 bounds。
 */
export function attachDetachedWindowLifecycle(
  win: BrowserWindow,
  windowId: string,
  onClosed?: () => void,
  options?: { trackBounds?: boolean },
): void {
  const trackBounds = options?.trackBounds ?? true

  if (trackBounds) {
    setupBoundsTracking(win, windowId)
  } else {
    setupMaximizeSync(win, windowId)
  }

  win.on('focus', () => {
    windowState.lastFocusedWin = win
  })

  win.on('close', () => {
    const state = windowStore.getOrDefault(windowId)
    if (!win.isDestroyed()) {
      if (trackBounds && !win.isMaximized()) {
        state.bounds = win.getBounds()
      }
      state.isMaximized = win.isMaximized()
      state.alwaysOnTop = win.isAlwaysOnTop()
      windowStore.save(windowId, state)
    }
    safeLogWindowTrace(windowId, 'close')
  })

  win.on('closed', () => {
    windowState.detachedWindows.delete(windowId)
    onClosed?.()
  })
}

/**
 * 为窗口的主 webContents 注册 F12 快捷键拦截。
 *
 * 适用场景：不含 <webview> 的窗口（如 chat 窗口）。含 webview 的主窗口由
 * attachWebviewPopupInterceptor 在 guest webContents 上注册 before-input-event，
 * 不含 webview 的窗口需在主 webContents 上单独注册，否则 Chromium 内置 F12
 * 行为会拦截按键，导致渲染层 keydown 无法生效。
 *
 * F12 → 置顶/取消置顶（主进程直接执行 + IPC 通知渲染层）
 */
export function attachWindowHotkeyInterceptor(parentWebContents: Electron.WebContents): void {
  parentWebContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const win = BrowserWindow.fromWebContents(parentWebContents)
    if (!win || win.isDestroyed()) return

    const mods = input.modifiers || []
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const key = input.key

    // F11：切换最大化/还原（接入 WindowMaximizeManager，等效 TitleBar 最大化按钮）
    // 与 attachWebviewPopupInterceptor 中的 F11 处理一致，统一走 toggleMaximizeForWindow
    if (key === 'F11' && !hasCtrl && !mods.includes('alt') && !mods.includes('shift')) {
      console.log('[hotkey] F11 → 切换最大化 (window-level)')
      e.preventDefault()
      const winId = findWindowIdByWin(win)
      toggleMaximizeForWindow(win, winId)
      return
    }

    // F12：置顶/取消置顶
    if (key === 'F12' && !hasCtrl) {
      console.log('[hotkey] F12 → 置顶切换 (window-level)')
      e.preventDefault()
      if (win.isMaximized()) {
        win.unmaximize()
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
      }
      if (win.isFullScreen()) {
        win.setFullScreen(false)
      }
      const windowId = findWindowIdByWin(win)
      const next = !win.isAlwaysOnTop()
      const actual = setAlwaysOnTopForWindow(win, windowId, next)
      parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual)
      return
    }
  })
}
