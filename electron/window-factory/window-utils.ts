// electron/window-factory/window-utils.ts — 窗口杂项工具
//
// 从 helpers.ts 抽离：窗口痕迹记录、表单默认尺寸、User-Agent 解析、窗口 ID 反查。

import { BrowserWindow } from 'electron'
import { getChatStore } from '../store/chat-store.js'
import { type WindowTraceAction, type ChatWindowConfig } from '../shared/types.js'
import { windowState } from '../window-state.js'
import { MAIN_WINDOW_ID } from '../store/window-store.js'
import {
  HISTORY_WINDOW_ID,
  PROMPT_WINDOW_ID,
  ADVANCED_PANEL_WINDOW_ID,
  ONBOARDING_WINDOW_ID,
  HISTORY_DOWNLOAD_WINDOW_ID,
} from './constants.js'

/**
 * 记录窗口操作痕迹到 SQLite（安全包装，chatStore 未就绪或失败不抛错）。
 * 用于追踪 create/close/maximize/minimize/tab_switch/pin_toggle 等行为。
 */
export function safeLogWindowTrace(windowId: string, action: WindowTraceAction, detail?: unknown): void {
  try {
    getChatStore().logWindowTrace(windowId, action, detail)
  } catch (e) {
    // chatStore 未初始化等异常时记录 debug 日志，避免正常运行刷屏
    console.debug('[safeLogWindowTrace] 记录窗口痕迹失败:', e)
  }
}

/** 根据 windowForm 获取默认窗口尺寸 */
export function getFormBounds(form?: 'narrow' | 'standard' | 'wide'): { width: number; height: number } {
  switch (form) {
    case 'wide':
      return { width: 1000, height: 680 }
    case 'standard':
      return { width: 720, height: 640 }
    case 'narrow':
    default:
      return { width: 480, height: 760 }
  }
}

/** 根据 uaPreset + userAgent 解析最终的 User-Agent 字符串（返回 null 表示用 Electron 默认） */
export function resolveUserAgent(config: ChatWindowConfig): string | null {
  switch (config.uaPreset) {
    case 'safari-ios':
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    case 'chrome-desktop':
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    case 'custom':
      return config.userAgent?.trim() || null
    default:
      return null
  }
}

/** 通过 BrowserWindow 实例反查 windowId */
export function findWindowIdByWin(win: BrowserWindow): string | null {
  if (win === windowState.mainWindow) return MAIN_WINDOW_ID
  if (win === windowState.historyWindow) return HISTORY_WINDOW_ID
  if (win === windowState.promptWindow) return PROMPT_WINDOW_ID
  if (win === windowState.advancedPanelWindow) return ADVANCED_PANEL_WINDOW_ID
  if (win === windowState.onboardingWindow) return ONBOARDING_WINDOW_ID
  if (win === windowState.historyDownloadWindow) return HISTORY_DOWNLOAD_WINDOW_ID
  if (win === windowState.previewWindow) return 'preview'
  for (const [id, w] of windowState.detachedWindows) {
    if (w === win) return id
  }
  // AI 应用编辑窗口反查（按 platformId 多例，windowId = `ai-app-editor-${platformId}`）
  if (windowState.aiAppEditorWindows) {
    for (const [wid, w] of windowState.aiAppEditorWindows) {
      if (w === win) return `ai-app-editor-${wid}`
    }
  }
  return null
}
