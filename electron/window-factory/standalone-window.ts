// electron/window-factory/standalone-window.ts — 脱离窗口创建
//
// 从原 window-factory.ts 抽离的 createStandaloneWindow。
// 函数体与原文件逐字一致，仅 import 来源调整为从 ./helpers.js 与上级模块。

import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { windowStore } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import {
  __dirname,
  WINDOW_BACKGROUND_COLOR,
  getPreloadPath,
  attachWebviewPopupInterceptor,
  loadRenderer,
  setupBoundsTracking,
  safeLogWindowTrace,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'

/**
 * 创建脱离窗口（单标签独立窗口）
 */
export function createStandaloneWindow(windowId: string): BrowserWindow {
  const saved = windowStore.getOrDefault(windowId)
  const workArea = screen.getPrimaryDisplay().workArea

  const win = new BrowserWindow(buildWindowConfig({
    width: saved.bounds.width || 420,
    height: saved.bounds.height || 820,
    x: saved.bounds.x,
    y: saved.bounds.y,
    minWidth: 320,
    minHeight: 520,
    show: false,
    frame: false,
    // resizable:true 让 setBounds 可自由缩小；原生 resize 边框由 thickFrame:false 禁用
    resizable: true,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  }))

  // 拦截 <webview> 内弹窗（脱离窗口内也可能打开新窗口）
  attachWebviewPopupInterceptor(win.webContents)

  if (
    saved.bounds.x != null &&
    saved.bounds.y != null &&
    saved.bounds.x < workArea.x + workArea.width - 100 &&
    saved.bounds.y < workArea.y + workArea.height - 100
  ) {
    win.setPosition(saved.bounds.x, saved.bounds.y)
  }
  if (saved.isMaximized) {
    win.maximize()
  }

  loadRenderer(win, windowId)

  win.once('ready-to-show', () => {
    win.show()
    safeLogWindowTrace(windowId, 'create')
  })

  windowState.detachedWindows.set(windowId, win)
  setupBoundsTracking(win, windowId)

  // 追踪最近聚焦窗口（置顶热键作用对象）
  win.on('focus', () => {
    windowState.lastFocusedWin = win
  })

  win.on('close', () => {
    const state = windowStore.getOrDefault(windowId)
    if (!win.isDestroyed()) {
      if (!win.isMaximized()) {
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
  })

  return win
}
