// electron/window-factory/advanced-panel-window.ts — 进阶面板（单例）
//
// 承载「自定义对话 / 白板 / 灵感笔记」三页的统一独立窗口。
// 单例：同一时间仅存在一个实例，再次调用 open 时复用并聚焦。
//
// 设计要点：
//   - 窗口 ID 固定为 'advanced-panel'（ADVANCED_PANEL_WINDOW_ID）。
//   - 通过 ?mode=advanced-panel 路由到 AdvancedPanelView。
//   - minWidth 由 calculateAdvancedPanelMinWidth(uiScale) 动态计算。
//   - openAdvancedPanelWindow(providerId?) 可携带 providerId，
//     通过 query 参数 initialProvider 传给渲染层，由其切换到对应供应商的对话页。
//   - toggleAdvancedPanelWindow() 供 Alt+Q 调用：窗口可见则关闭（下次重新打开按 settings.defaultAdvancedPanelTab 路由），
//     不存在则创建并按默认 tab 路由。
//
// 依赖关系：advanced-panel-window → helpers（无循环依赖）。

import { BrowserWindow, screen } from 'electron'
import { windowStore } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import {
  WINDOW_BACKGROUND_COLOR,
  ADVANCED_PANEL_WINDOW_ID,
  getPreloadPath,
  createDefaultWebPreferences,
  attachDetachedWindowLifecycle,
  safeLogWindowTrace,
  attachWindowHotkeyInterceptor,
  loadRenderer,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import {
  calculateAdvancedPanelMinWidth,
  getUiScaleFromSettings,
  ADVANCED_PANEL_MIN_HEIGHT,
} from './window-size-helpers.js'
import { getAppSettings } from '../store/app-settings-store.js'

/** 渲染层加载 URL 时附加的 query 参数（仅生产环境 loadFile 路径使用） */
interface AdvancedPanelWindowOptions {
  /** 初始展示的供应商 id（切换到「自定义对话」页并选中该 provider） */
  providerId?: string
  /** 初始展示的页签：'chat' | 'whiteboard' | 'notes'。默认 'chat'（Alt+Q 入口语义） */
  initialTab?: 'chat' | 'whiteboard' | 'notes'
}

/**
 * 创建 进阶面板（单例）。
 * 若已存在则聚焦并返回；否则新建。
 */
export function createAdvancedPanelWindow(options?: AdvancedPanelWindowOptions): BrowserWindow {
  // 单例检查：已存在则聚焦并通知渲染层切换 tab/provider
  const existing = windowState.advancedPanelWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    // 通知渲染层切换到指定 tab/provider
    if (!existing.webContents.isDestroyed()) {
      existing.webContents.send(IPC_CHANNELS.ADVANCED_PANEL_NAVIGATE, {
        tab: options?.initialTab ?? 'chat',
        providerId: options?.providerId,
      })
    }
    return existing
  }

  const saved = windowStore.getOrDefault(ADVANCED_PANEL_WINDOW_ID)
  // 区分"用户真实保存的 bounds"与 getOrDefault 返回的默认占位 bounds（420×820，为 webview 主窗口设计的窄长形态）。
  // 本窗口为 API 直连聊天界面（webviewTag:false），首次打开应使用 900×680，仅在用户曾保存过时才用 saved 尺寸。
  const hasSavedBounds = !!windowStore.get(ADVANCED_PANEL_WINDOW_ID)
  const workArea = screen.getPrimaryDisplay().workArea
  // 默认尺寸 900×680，居中显示；用户已保存 bounds 则优先用
  const width = (hasSavedBounds && saved.bounds.width) || Math.min(900, workArea.width - 80)
  const height = (hasSavedBounds && saved.bounds.height) || Math.min(680, workArea.height - 80)
  const x = saved.bounds.x ?? workArea.x + Math.round((workArea.width - width) / 2)
  const y = saved.bounds.y ?? workArea.y + Math.round((workArea.height - height) / 2)

  // 根据 UI 比例动态计算最小宽度
  const uiScale = getUiScaleFromSettings()
  const minWidth = calculateAdvancedPanelMinWidth(uiScale)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth,
    minHeight: ADVANCED_PANEL_MIN_HEIGHT,
    show: false,
    frame: false,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '进阶面板',
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: false, // 进阶面板不使用 webview（API 直连 + 内置平台网格只发 IPC）
    }),
  }))

  windowState.advancedPanelWindow = win

  if (saved.isMaximized) {
    win.maximize()
  }

  loadRenderer(win, ADVANCED_PANEL_WINDOW_ID, 'advanced-panel', {
    ...(options?.providerId ? { provider: options.providerId } : {}),
    ...(options?.initialTab ? { tab: options.initialTab } : {}),
  })
  // 进阶面板不含 webview，需在主 webContents 上注册 F12 拦截
  attachWindowHotkeyInterceptor(win.webContents)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    safeLogWindowTrace(ADVANCED_PANEL_WINDOW_ID, 'create')
  })

  attachDetachedWindowLifecycle(win, ADVANCED_PANEL_WINDOW_ID, () => {
    windowState.advancedPanelWindow = null
  })

  return win
}

/**
 * 打开 进阶面板（单例）。
 * 若窗口已存在则聚焦并切换到指定 tab/provider；否则创建。
 */
export function openAdvancedPanelWindow(options?: AdvancedPanelWindowOptions): void {
  createAdvancedPanelWindow(options)
}

/**
 * 显示 进阶面板（仅显示，不创建）。
 * 用于外部调用方需要确保窗口可见但不强制创建的场景。
 */
export function showAdvancedPanelWindow(): void {
  const win = windowState.advancedPanelWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** 聚焦 进阶面板（仅聚焦，不创建） */
export function focusAdvancedPanelWindow(): void {
  const win = windowState.advancedPanelWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * 切换 进阶面板（Alt+Q 入口）。
 * - 窗口存在且可见 → 关闭（destroy），下次 Alt+Q 重新创建并路由到默认 tab
 * - 窗口不存在 → 创建（按用户设置的 defaultAdvancedPanelTab 路由，默认 'chat'）
 *
 * 设计说明：采用「关闭」而非「隐藏」语义，确保每次 Alt+Q 重新打开时
 * 都能根据 settings.defaultAdvancedPanelTab 路由到用户指定的默认标签页。
 * win.close() 会触发 close/closed 事件，完成 bounds 持久化与 state 清理。
 */
export function toggleAdvancedPanelWindow(): void {
  const win = windowState.advancedPanelWindow
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) {
      console.log('[advanced-panel-window] Alt+Q 关闭 进阶面板（下次重新打开路由到默认 tab）')
      win.close()
    } else {
      // 隐藏状态（极少出现，例如最小化到任务栏后被系统隐藏）：显示并聚焦
      console.log('[advanced-panel-window] Alt+Q 显示 进阶面板')
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    return
  }
  // 不存在则创建（读取用户设置的默认 tab，默认 'chat'）
  const settings = getAppSettings()
  createAdvancedPanelWindow({ initialTab: settings.defaultAdvancedPanelTab ?? 'chat' })
}
