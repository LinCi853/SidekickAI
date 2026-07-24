// electron/window-factory/popup-windows.ts — 独立弹出窗口创建/切换
//
// 从原 window-factory.ts 抽离的 showHistoryWindow / showPromptWindow。
// 函数体与原文件逐字一致，仅 import 来源调整为从 ./helpers.js 与上级模块。

import { windowState } from '../window-state.js'
import {
  HISTORY_WINDOW_ID,
  PROMPT_WINDOW_ID,
  createSingletonPopupWindow,
} from './helpers.js'

/**
 * 创建/显示历史搜索独立窗口（单例）。
 * 列举所有本地保存数据：对话会话（webview 抓取 + API 直连）、登录痕迹、窗口操作痕迹。
 * 窗口关闭时仅隐藏（复用），before-quit 时销毁。
 */
export function showHistoryWindow(): void {
  createSingletonPopupWindow({
    width: 960,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    title: '历史搜索',
    windowId: HISTORY_WINDOW_ID,
    mode: 'history',
    getExisting: () => windowState.historyWindow,
    setWindow: (win) => { windowState.historyWindow = win },
  })
}

/**
 * 创建/显示提示词库独立窗口（单例）。
 * 不遮挡主页面：独立窗口，点击提示词时通过 IPC 请求主窗口注入激活 webview。
 */
export function showPromptWindow(): void {
  createSingletonPopupWindow({
    width: 560,
    height: 640,
    minWidth: 360,
    minHeight: 400,
    title: '提示词库',
    windowId: PROMPT_WINDOW_ID,
    mode: 'prompts',
    getExisting: () => windowState.promptWindow,
    setWindow: (win) => { windowState.promptWindow = win },
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
  // 单例 key：编辑模式用 profileId，新建模式固定 'create'
  const windowKey =
    opts.mode === 'create'
      ? 'create'
      : opts.profileId ?? opts.platformId ?? 'default'

  // windowId 编码全部 opts（Base64 JSON），供渲染器解析
  const encodedOpts = Buffer.from(JSON.stringify(opts)).toString('base64')

  createSingletonPopupWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: opts.mode === 'create' ? '新建 AI 应用' : 'AI 应用配置',
    windowId: `ai-app-editor-${encodedOpts}`,
    mode: 'ai-app-editor',
    getExisting: () => windowState.aiAppEditorWindows.get(windowKey),
    setWindow: (win) => {
      if (win) windowState.aiAppEditorWindows.set(windowKey, win)
      else windowState.aiAppEditorWindows.delete(windowKey)
    },
  })
}

/**
 * 创建/显示数据迁移独立窗口（单例）。
 * 提供细粒度导出选项（基础数据 / 登录凭据 / 应用数据 / 离线缓存 / 语音模型）+ 三档预设 + 导入功能。
 * 已存在则聚焦，不重复打开。
 */
export function showDataExportWindow(): void {
  createSingletonPopupWindow({
    width: 600,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    title: '数据迁移',
    windowId: 'data-export',
    mode: 'data-export',
    getExisting: () => windowState.dataExportWindow,
    setWindow: (win) => { windowState.dataExportWindow = win },
  })
}
