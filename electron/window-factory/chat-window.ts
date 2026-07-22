// electron/window-factory/chat-window.ts — 自定义对话窗口创建
//
// 从原 window-factory.ts 抽离的 createChatWindow / createChatDetachedWindow。
// 函数体与原文件逐字一致，仅 import 来源调整为从 ./helpers.js 与上级模块。

import { BrowserWindow } from 'electron'
import path from 'path'
import { windowStore } from '../store/window-store.js'
import { type ChatWindowConfig } from '../shared/types.js'
import { windowState } from '../window-state.js'
import {
  __dirname,
  WINDOW_BACKGROUND_COLOR,
  getPreloadPath,
  getFormBounds,
  loadRenderer,
  resolveUserAgent,
  setupBoundsTracking,
  safeLogWindowTrace,
  attachWindowHotkeyInterceptor,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import { calculateChatWindowMinWidth, getUiScaleFromSettings, CHAT_WINDOW_MIN_HEIGHT } from './window-size-helpers.js'

/**
 * 创建自定义对话窗口（API 直连模式）
 *
 * 与主窗口/脱离窗口不同：该窗口加载 ?windowId=chat，渲染 ChatView。
 * 不使用 webview，直接在渲染进程内调用 API 客户端。
 */
export function createChatWindow(): BrowserWindow | null {
  // 已存在则聚焦
  const existing = BrowserWindow.getAllWindows().find((w) => {
    try {
      const url = w.webContents.getURL()
      return url.includes('windowId=chat')
    } catch {
      return false
    }
  })
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    return existing
  }

  const CHAT_WINDOW_ID = 'chat'
  const saved = windowStore.getOrDefault(CHAT_WINDOW_ID)
  // 根据 UI 比例动态计算最小宽度（替代硬编码 360）
  const uiScale = getUiScaleFromSettings()
  const minWidth = calculateChatWindowMinWidth(uiScale)
  const win = new BrowserWindow(buildWindowConfig({
    // 默认宽屏尺寸 900×680（适合对话场景）
    width: saved.bounds.width || 900,
    height: saved.bounds.height || 680,
    x: saved.bounds.x,
    y: saved.bounds.y,
    minWidth,
    minHeight: CHAT_WINDOW_MIN_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))

  if (saved.isMaximized) {
    win.maximize()
  }

  // 加载渲染进程（附加 windowId=chat）
  if (process.env.ELECTRON_RENDERER_URL) {
    const sep = process.env.ELECTRON_RENDERER_URL.includes('?') ? '&' : '?'
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${sep}windowId=chat`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query: { windowId: 'chat' },
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    safeLogWindowTrace(CHAT_WINDOW_ID, 'create')
  })

  // chat 窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  // 否则 Chromium 内置 F11 全屏会拦截按键，渲染层 keydown 无法生效
  attachWindowHotkeyInterceptor(win.webContents)

  // 窗口控制 IPC 由调用方所在窗口自行处理（WIN_CONTROL_* 复用），
  // 但脱离窗口的 IPC 复用同一通道，需要 findWindowIdByWin 正确返回 'chat'
  windowState.detachedWindows.set(CHAT_WINDOW_ID, win)
  setupBoundsTracking(win, CHAT_WINDOW_ID)

  win.on('focus', () => {
    windowState.lastFocusedWin = win
  })

  win.on('close', () => {
    const state = windowStore.getOrDefault(CHAT_WINDOW_ID)
    if (!win.isDestroyed()) {
      if (!win.isMaximized()) {
        state.bounds = win.getBounds()
      }
      state.isMaximized = win.isMaximized()
      state.alwaysOnTop = win.isAlwaysOnTop()
      windowStore.save(CHAT_WINDOW_ID, state)
    }
    safeLogWindowTrace(CHAT_WINDOW_ID, 'close')
  })

  win.on('closed', () => {
    windowState.detachedWindows.delete(CHAT_WINDOW_ID)
  })

  return win
}

/**
 * 创建自定义对话脱离窗口（mode='chat'，Alt+Q 可切换）
 *
 * 与单例 chat 窗口不同：每个自定义对话窗口有独立 UUID，绑定指定 AI 供应商 + 样式配置，
 * 持久化到 windowStore，Alt+Q 统一切换显隐。
 */
export function createChatDetachedWindow(windowId: string, config: ChatWindowConfig): BrowserWindow {
  const saved = windowStore.getOrDefault(windowId)
  // 根据 windowForm 决定默认尺寸；config.bounds 显式提供则优先用
  const formBounds = getFormBounds(config.windowForm)
  const width = config.bounds?.width ?? (saved.bounds.width || formBounds.width)
  const height = config.bounds?.height ?? (saved.bounds.height || formBounds.height)
  // 根据 UI 比例动态计算最小宽度（替代硬编码 360）
  const uiScale = getUiScaleFromSettings()
  const minWidth = calculateChatWindowMinWidth(uiScale)
  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x: saved.bounds.x,
    y: saved.bounds.y,
    minWidth,
    minHeight: CHAT_WINDOW_MIN_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))

  if (saved.isMaximized) {
    win.maximize()
  }

  // 设置 User-Agent（根据 uaPreset + userAgent；未设置则保留 Electron 默认）
  const ua = resolveUserAgent(config)
  if (ua) {
    win.webContents.setUserAgent(ua)
  }

  // 加载渲染进程（附加 windowId + mode=chat）
  loadRenderer(win, windowId, 'chat')

  win.once('ready-to-show', () => {
    win.show()
    safeLogWindowTrace(windowId, 'create')
  })

  // chat 脱离窗口不含 webview，同样需要 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  windowState.detachedWindows.set(windowId, win)
  setupBoundsTracking(win, windowId)

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

