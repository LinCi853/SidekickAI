// electron-api.ts — ElectronAPI 根接口（通过 contextBridge 暴露到渲染进程的完整 API）

import type { ProfileAPI, WindowAPI, WindowControlAPI, WindowStateAPI, TabAPI, PresetsAPI } from './profile-window.api.js'
import type { ChatAPI, AIProviderAPI, AIPlatformAPI, PromptAPI, InjectionHistoryAPI } from './chat.api.js'
import type { SttAPI, VoiceConfigAPI } from './voice.api.js'
import type { AppSettingsAPI, OnboardingAPI, BlockRulesAPI, FingerprintAPI, PlatformCapabilitiesAPI, AppSettings } from './settings.api.js'
import type { NotesAPI, WhiteboardAPI } from './notes-whiteboard.api.js'
import type { BrowserAPI, BookmarkAPI, NavHistoryAPI, HotkeyAPI } from './browser.api.js'
import type { FreezeAPI } from './freeze.api.js'
import type { PromptTemplate } from '../chat.types.js'

/** 通过 contextBridge 暴露到渲染进程的完整 API */
export interface ElectronAPI {
  profile: ProfileAPI
  window: WindowAPI
  windowControl: WindowControlAPI
  windowState: WindowStateAPI
  tab: TabAPI
  presets: PresetsAPI
  stt: SttAPI
  hotkey: HotkeyAPI
  aiPlatform: AIPlatformAPI
  prompt: PromptAPI
  /** 注入历史管理（需求 2：注入预览 + Jaccard 去重） */
  injection: InjectionHistoryAPI
  aiProvider: AIProviderAPI
  chat: ChatAPI
  fingerprint: FingerprintAPI
  /** 语音输入配置（enterToSend 等全局设置） */
  voice: VoiceConfigAPI
  /** 应用全局设置（区域代理、隐藏国外模型等） */
  appSettings: AppSettingsAPI
  /** 引导 API（首次启动引导窗 + 重新查看入口） */
  onboarding: OnboardingAPI
  /** 灵感笔记 API（需求 11：浮窗 CRUD + 发送到 AI 输入框 + 存为提示词） */
  notes: NotesAPI
  /** 白板 API（需求 12：无限画布 + 卡片 + 箭头 + 手绘线条） */
  whiteboard: WhiteboardAPI
  /** 平台能力查询（设置页显示权限状态） */
  platformCapabilities: PlatformCapabilitiesAPI
  /** 主进程 → 渲染层：拦截 webview 弹窗后新建标签页 */
  onNewTab: (callback: (url: string, windowId: string) => void) => () => void
  /**
   * 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
   * 将 URL + guest webContents id 发回渲染层，由渲染层在匹配的当前 webview 内导航，
   * 实现页面内跳转而非弹出新窗口）。返回取消监听的函数。
   */
  onWebviewPopupUrl: (
    callback: (payload: { url: string; webContentsId: number }) => void,
  ) => () => void
  /** 窗口重新显示/聚焦到前台（主→渲染：聚焦输入框） */
  onWindowShown: (callback: () => void) => () => void
  /** 窗口隐藏（主→渲染：自动收起展开的面板） */
  onWindowHidden: (callback: () => void) => () => void
  /** 主→渲染：弹窗被连续拦截 N 次后提示用户加白 */
  onPopupDenied: (callback: (data: { origin: string; count: number }) => void) => () => void
  /** 渲染→主：添加 origin 到全局弹窗白名单 */
  addToPopupWhitelist: (origin: string) => Promise<void>
  /** 渲染→主：添加 origin 到 Profile 专属弹窗白名单 */
  addToProfilePopupWhitelist: (profileId: string, origin: string) => Promise<void>
  /** 主→最近聚焦窗口渲染：后台识别文本到达，注入 AI 输入框；enterToSend 控制是否自动发送 */
  onVoiceInjectAndSend: (cb: (payload: { text: string; enterToSend: boolean }) => void) => () => void
  /** 主→预览窗渲染：更新文本/状态 */
  onPreviewUpdate: (
    cb: (payload: { text: string; status: 'recording' | 'transcribing' | 'done' | 'sent' }) => void,
  ) => () => void
  /** 主→预览窗渲染：隐藏 */
  onPreviewHide: (cb: () => void) => () => void
  /** 主→预览窗渲染：开始录音（getUserMedia） */
  onVoiceRecordStart: (cb: () => void) => () => void
  /** 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行） */
  onWebviewHotkey: (
    callback: (payload: {
      action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab' | 'detachCurrent'
      data?: unknown
    }) => void,
  ) => () => void
  /** 主→预览窗渲染：停止录音并回传 PCM */
  onVoiceRecordStop: (cb: () => void) => () => void
  /** 预览窗渲染→主：回传 Float32 PCM 数据 */
  sendVoiceRecordData: (data: number[]) => void
  /** 主→主窗口渲染：提示词库窗口请求注入模板到激活 webview（需求 1：传递完整模板由主窗口组合） */
  onPromptInjectRequest: (cb: (template: PromptTemplate) => void) => () => void
  /** 主→提示词库窗口渲染：注入结果回传 */
  onPromptInjectResult: (cb: (result: { success: boolean; platformName?: string }) => void) => () => void
  /** 主窗口渲染 → 主进程：回传注入结果（主进程转发到提示词库窗口，供其显示 toast） */
  sendPromptInjectResult: (result: { success: boolean; platformName?: string }) => void
  /** 页面组件屏蔽规则管理 */
  blockRules: BlockRulesAPI
  /**
   * 打开 AI 应用编辑窗口（多例，按 windowKey 单例）。
   * - 编辑模式：传 profileId 精确定位 Profile（支持同一平台多实例）
   * - 新建模式：mode='create'，表单空白，用户自由配置后创建
   */
  openAiAppEditor: (opts: {
    platformId?: string
    profileId?: string
    mode?: 'edit' | 'create'
  }) => Promise<void>
  /** 打开设置独立窗口（单例，左导航+右内容布局） */
  openSettingsWindow: () => Promise<void>
  /** 打开历史记录与下载管理独立窗口（单例，导航历史 + 下载管理） */
  openHistoryDownloadWindow: () => Promise<void>
  /**
   * 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）。
   * 可选 providerId：若提供则切换到对应自定义供应商的对话页。
   */
  openAdvancedPanelWindow: (providerId?: string) => Promise<void>
  /** 切换 进阶面板显隐（单例） */
  toggleAdvancedPanelWindow: () => Promise<void>
  /** 主→渲染：单例窗口复用时通知切换 tab/provider */
  onAdvancedPanelNavigate: (
    callback: (payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) => void,
  ) => () => void
  /** 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后通知各窗口重新计算最小尺寸） */
  onUiScaleChanged: (callback: (uiScale: 'small' | 'medium' | 'large') => void) => () => void
  /** 主→渲染：应用设置变更广播（任意窗口修改设置后通知所有窗口同步） */
  onAppSettingsChanged: (callback: (settings: AppSettings) => void) => () => void
  /** 渲染→主：请求广播 UI 版本/主题变更到所有窗口 */
  broadcastUiVersionChanged: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void
  /** 主→渲染：UI 版本/主题变更广播 */
  onUiVersionChanged: (callback: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void) => () => void
  /** 浏览器窗口（v0.0.9：多标签浏览器） */
  browser: BrowserAPI
  /** 导航历史追踪（主窗口上报，脱离时聚合） */
  navHistory: NavHistoryAPI
  /** 页面冻结（v0.1.0 防撤回保险：Debugger.pause 冻结 webview） */
  freeze: FreezeAPI
}
