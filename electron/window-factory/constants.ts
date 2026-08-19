// electron/window-factory/constants.ts — 窗口工厂常量
//
// 从 helpers.ts 抽离的常量：窗口统一背景色 + 各独立窗口 ID。

/** 应用窗口统一背景色（与渲染层主题色一致，避免启动白闪） */
export const WINDOW_BACKGROUND_COLOR = '#1f1719'

// 历史搜索独立窗口（单例，列举所有本地保存数据）
export const HISTORY_WINDOW_ID = 'history'
// 提示词库独立窗口（单例，不遮挡主页面）
export const PROMPT_WINDOW_ID = 'prompts'
// 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）
export const ADVANCED_PANEL_WINDOW_ID = 'advanced-panel'
// 引导独立窗口（单例，首次启动或「使用指南」入口）
export const ONBOARDING_WINDOW_ID = 'onboarding'
// 历史记录与下载管理独立窗口（单例，导航历史 + 下载管理）
export const HISTORY_DOWNLOAD_WINDOW_ID = 'history-download'
