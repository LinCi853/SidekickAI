// electron/window-factory/history-download-window.ts — 历史记录与下载管理独立窗口
//
// 单例独立窗口：左侧切换「导航历史 / 下载管理」，右侧展示对应面板。
// 导航历史持久化（SQLite），下载管理复用 browser-download-store。
// 已存在则聚焦，不重复打开。参考 showHistoryWindow / showSettingsWindow 模式。

import { windowState } from '../window-state.js'
import {
  HISTORY_DOWNLOAD_WINDOW_ID,
  createSingletonPopupWindow,
} from './helpers.js'

/**
 * 创建/显示历史记录与下载管理独立窗口（单例）。
 * 左导航+右内容布局：导航历史（按时间分组/搜索/删除/清空）+ 下载管理（打开/定位/删除/清空）。
 */
export function showHistoryDownloadWindow(): void {
  createSingletonPopupWindow({
    width: 900,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: '工百窗 - 历史记录与下载管理',
    windowId: HISTORY_DOWNLOAD_WINDOW_ID,
    mode: 'history-download',
    getExisting: () => windowState.historyDownloadWindow,
    setWindow: (win) => { windowState.historyDownloadWindow = win },
  })
}
