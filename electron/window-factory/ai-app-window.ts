// electron/window-factory/ai-app-window.ts — AI 应用独立窗口（单例）
//
// 承载「AI 应用 / 自定义供应商 / 自定义对话」三页的统一独立窗口。
// 单例：同一时间仅存在一个实例，再次调用 open 时复用并聚焦。
//
// 设计要点：
//   - 窗口 ID 固定为 'ai-app-provider'（AI_APP_PROVIDER_WINDOW_ID）。
//   - 通过 ?mode=ai-app-provider 路由到 AiProviderAppView。
//   - minWidth 由 calculateAiAppWindowMinWidth(uiScale) 动态计算。
//   - openAiAppProviderWindow(providerId?) 可携带 providerId，
//     通过 query 参数 initialProvider 传给渲染层，由其切换到对应供应商的对话页。
//   - toggleAiAppProviderWindow() 供 Alt+Q 调用：窗口可见则关闭（下次重新打开按 settings.defaultAiAppTab 路由），
//     不存在则创建并按默认 tab 路由。
//
// 依赖关系：ai-app-window → helpers（无循环依赖）。

import { BrowserWindow, screen } from 'electron'
import { windowStore } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import {
  WINDOW_BACKGROUND_COLOR,
  AI_APP_PROVIDER_WINDOW_ID,
  getPreloadPath,
  createDefaultWebPreferences,
  attachDetachedWindowLifecycle,
  safeLogWindowTrace,
  attachWindowHotkeyInterceptor,
  loadRenderer,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import {
  calculateAiAppWindowMinWidth,
  getUiScaleFromSettings,
  AI_APP_WINDOW_MIN_HEIGHT,
} from './window-size-helpers.js'
import { getAppSettings } from '../store/app-settings-store.js'

/** 渲染层加载 URL 时附加的 query 参数（仅生产环境 loadFile 路径使用） */
interface AiAppProviderWindowOptions {
  /** 初始展示的供应商 id（切换到「自定义对话」页并选中该 provider） */
  providerId?: string
  /** 初始展示的页签：'chat' | 'whiteboard' | 'notes'。默认 'chat'（Alt+Q 入口语义） */
  initialTab?: 'chat' | 'whiteboard' | 'notes'
}

/**
 * 创建 AI 应用独立窗口（单例）。
 * 若已存在则聚焦并返回；否则新建。
 */
export function createAiAppProviderWindow(options?: AiAppProviderWindowOptions): BrowserWindow {
  // 单例检查：已存在则聚焦并通知渲染层切换 tab/provider
  const existing = windowState.aiAppProviderWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    // 通知渲染层切换到指定 tab/provider
    if (!existing.webContents.isDestroyed()) {
      existing.webContents.send(IPC_CHANNELS.AI_APP_PROVIDER_NAVIGATE, {
        tab: options?.initialTab ?? 'chat',
        providerId: options?.providerId,
      })
    }
    return existing
  }

  const saved = windowStore.getOrDefault(AI_APP_PROVIDER_WINDOW_ID)
  // 区分"用户真实保存的 bounds"与 getOrDefault 返回的默认占位 bounds（420×820，为 webview 主窗口设计的窄长形态）。
  // 本窗口为 API 直连聊天界面（webviewTag:false），首次打开应使用 900×680，仅在用户曾保存过时才用 saved 尺寸。
  const hasSavedBounds = !!windowStore.get(AI_APP_PROVIDER_WINDOW_ID)
  const workArea = screen.getPrimaryDisplay().workArea
  // 默认尺寸 900×680，居中显示；用户已保存 bounds 则优先用
  const width = (hasSavedBounds && saved.bounds.width) || Math.min(900, workArea.width - 80)
  const height = (hasSavedBounds && saved.bounds.height) || Math.min(680, workArea.height - 80)
  const x = saved.bounds.x ?? workArea.x + Math.round((workArea.width - width) / 2)
  const y = saved.bounds.y ?? workArea.y + Math.round((workArea.height - height) / 2)

  // 根据 UI 比例动态计算最小宽度
  const uiScale = getUiScaleFromSettings()
  const minWidth = calculateAiAppWindowMinWidth(uiScale)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth,
    minHeight: AI_APP_WINDOW_MIN_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: 'AI 应用',
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: false, // AI 应用独立窗口不使用 webview（API 直连 + 内置平台网格只发 IPC）
    }),
  }))

  windowState.aiAppProviderWindow = win

  if (saved.isMaximized) {
    win.maximize()
  }

  loadRenderer(win, AI_APP_PROVIDER_WINDOW_ID, 'ai-app-provider', {
    ...(options?.providerId ? { provider: options.providerId } : {}),
    ...(options?.initialTab ? { tab: options.initialTab } : {}),
  })
  // AI 应用独立窗口不含 webview，需在主 webContents 上注册 F11/F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    safeLogWindowTrace(AI_APP_PROVIDER_WINDOW_ID, 'create')
  })

  attachDetachedWindowLifecycle(win, AI_APP_PROVIDER_WINDOW_ID, () => {
    windowState.aiAppProviderWindow = null
  })

  return win
}

/**
 * 打开 AI 应用独立窗口（单例）。
 * 若窗口已存在则聚焦并切换到指定 tab/provider；否则创建。
 */
export function openAiAppProviderWindow(options?: AiAppProviderWindowOptions): void {
  createAiAppProviderWindow(options)
}

/**
 * 显示 AI 应用独立窗口（仅显示，不创建）。
 * 用于外部调用方需要确保窗口可见但不强制创建的场景。
 */
export function showAiAppProviderWindow(): void {
  const win = windowState.aiAppProviderWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** 聚焦 AI 应用独立窗口（仅聚焦，不创建） */
export function focusAiAppProviderWindow(): void {
  const win = windowState.aiAppProviderWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * 切换 AI 应用独立窗口（Alt+Q 入口）。
 * - 窗口存在且可见 → 关闭（destroy），下次 Alt+Q 重新创建并路由到默认 tab
 * - 窗口不存在 → 创建（按用户设置的 defaultAiAppTab 路由，默认 'chat'）
 *
 * 设计说明：采用「关闭」而非「隐藏」语义，确保每次 Alt+Q 重新打开时
 * 都能根据 settings.defaultAiAppTab 路由到用户指定的默认标签页。
 * win.close() 会触发 close/closed 事件，完成 bounds 持久化与 state 清理。
 */
export function toggleAiAppProviderWindow(): void {
  const win = windowState.aiAppProviderWindow
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) {
      console.log('[ai-app-window] Alt+Q 关闭 AI 应用独立窗口（下次重新打开路由到默认 tab）')
      win.close()
    } else {
      // 隐藏状态（极少出现，例如最小化到任务栏后被系统隐藏）：显示并聚焦
      console.log('[ai-app-window] Alt+Q 显示 AI 应用独立窗口')
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    return
  }
  // 不存在则创建（读取用户设置的默认 tab，默认 'chat'）
  const settings = getAppSettings()
  createAiAppProviderWindow({ initialTab: settings.defaultAiAppTab ?? 'chat' })
}
