// electron/window-factory/popup-windows.ts — 独立弹出窗口创建/切换
//
// 从原 window-factory.ts 抽离的 showHistoryWindow / showPromptWindow。
// 函数体与原文件逐字一致，仅 import 来源调整为从 ./helpers.js 与上级模块。

import { BrowserWindow, screen } from 'electron'
import path from 'path'
import { windowState } from '../window-state.js'
import {
  __dirname,
  WINDOW_BACKGROUND_COLOR,
  getPreloadPath,
  HISTORY_WINDOW_ID,
  PROMPT_WINDOW_ID,
  loadRenderer,
  attachWindowHotkeyInterceptor,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'

/**
 * 创建/显示历史搜索独立窗口（单例）。
 * 列举所有本地保存数据：对话会话（webview 抓取 + API 直连）、登录痕迹、窗口操作痕迹。
 * 窗口关闭时仅隐藏（复用），before-quit 时销毁。
 */
export function showHistoryWindow(): void {
  if (windowState.historyWindow && !windowState.historyWindow.isDestroyed()) {
    if (windowState.historyWindow.isMinimized()) windowState.historyWindow.restore()
    if (!windowState.historyWindow.isVisible()) windowState.historyWindow.show()
    windowState.historyWindow.focus()
    return
  }
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(960, workArea.width - 80)
  const height = Math.min(720, workArea.height - 80)
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: 560,
    minHeight: 420,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '历史搜索',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))
  windowState.historyWindow = win
  loadRenderer(win, HISTORY_WINDOW_ID, 'history')
  // 历史搜索窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    windowState.historyWindow = null
  })
}

/**
 * 创建/显示提示词库独立窗口（单例）。
 * 不遮挡主页面：独立窗口，点击提示词时通过 IPC 请求主窗口注入激活 webview。
 */
export function showPromptWindow(): void {
  if (windowState.promptWindow && !windowState.promptWindow.isDestroyed()) {
    if (windowState.promptWindow.isMinimized()) windowState.promptWindow.restore()
    if (!windowState.promptWindow.isVisible()) windowState.promptWindow.show()
    windowState.promptWindow.focus()
    return
  }
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(560, workArea.width - 80)
  const height = Math.min(640, workArea.height - 80)
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: 360,
    minHeight: 400,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '提示词库',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))
  windowState.promptWindow = win
  loadRenderer(win, PROMPT_WINDOW_ID, 'prompts')
  // 提示词库窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    windowState.promptWindow = null
  })
}

/**
 * 创建/显示 AI 应用编辑独立窗口（多例，按 windowKey 单例）。
 * - 编辑模式：windowKey = profileId（精确到实例，支持同一平台多实例）
 * - 新建模式：windowKey = 'create'（同时只能开一个新建窗口）
 * windowId 编码全部 opts（Base64 JSON），供渲染器解析。
 */
export function showAiAppEditorWindow(opts: {
  platformId?: string;
  profileId?: string;
  mode?: 'edit' | 'create';
}): void {
  // 1. 单例 key：编辑模式用 profileId，新建模式固定 'create'
  const windowKey =
    opts.mode === 'create'
      ? 'create'
      : opts.profileId ?? opts.platformId ?? 'default'

  // 2. 单例检查：同一 key 的编辑窗口已存在则聚焦
  const existing = windowState.aiAppEditorWindows.get(windowKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    return
  }

  // 3. 计算居中位置
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(640, workArea.width - 80)
  const height = Math.min(720, workArea.height - 80)
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  // 4. 创建 BrowserWindow
  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: 480,
    minHeight: 400,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: opts.mode === 'create' ? '新建 AI 应用' : 'AI 应用配置',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))

  // 5. 缓存
  windowState.aiAppEditorWindows.set(windowKey, win)

  // 6. 加载渲染器，windowId 编码全部 opts（Base64 JSON），mode 使用 'ai-app-editor'
  const encodedOpts = Buffer.from(JSON.stringify(opts)).toString('base64')
  loadRenderer(win, `ai-app-editor-${encodedOpts}`, 'ai-app-editor')
  // AI 应用编辑窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  // 7. ready-to-show
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // 8. closed 清理
  win.on('closed', () => {
    windowState.aiAppEditorWindows.delete(windowKey)
  })
}

/**
 * 创建/显示数据迁移独立窗口（单例）。
 * 提供细粒度导出选项（基础数据 / 登录凭据 / 应用数据 / 离线缓存 / 语音模型）+ 三档预设 + 导入功能。
 * 已存在则聚焦，不重复打开。
 */
export function showDataExportWindow(): void {
  // 1. 单例检查
  if (windowState.dataExportWindow && !windowState.dataExportWindow.isDestroyed()) {
    if (windowState.dataExportWindow.isMinimized()) windowState.dataExportWindow.restore()
    if (!windowState.dataExportWindow.isVisible()) windowState.dataExportWindow.show()
    windowState.dataExportWindow.focus()
    return
  }

  // 2. 计算居中位置
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(600, workArea.width - 80)
  const height = Math.min(720, workArea.height - 80)
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  // 3. 创建 BrowserWindow
  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: 480,
    minHeight: 560,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '数据迁移',
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  }))

  // 4. 缓存
  windowState.dataExportWindow = win

  // 5. 加载渲染器，windowId='data-export'，mode='data-export'
  loadRenderer(win, 'data-export', 'data-export')
  // 数据导出窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  // 6. ready-to-show
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // 7. closed 清理
  win.on('closed', () => {
    windowState.dataExportWindow = null
  })
}
