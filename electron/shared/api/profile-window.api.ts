// profile-window.api.ts — Profile / Window / Tab / Presets 管理接口

import type { Profile, DevicePreset } from '../profile.types.js'
import type { WindowStateData, TabState } from '../window.types.js'

/** Profile 管理接口 */
export interface ProfileAPI {
  list(): Promise<Profile[]>
  create(partial: Partial<Profile>): Promise<Profile>
  update(id: string, patch: Partial<Profile>): Promise<Profile>
  delete(id: string): Promise<void>
  duplicate(id: string): Promise<Profile>
  /** 拖拽排序：按 orderedIds 顺序重置 Profile 的 order 字段（主进程广播 PROFILE_REORDERED） */
  reorder(orderedIds: string[]): Promise<boolean>
  /** 监听 Profile 被任意窗口更新后的广播（跨窗口同步名称等字段） */
  onUpdated(callback: (data: { id: string; profile: Profile }) => void): () => void
  /** 监听 Profile 新建/复制后的广播（跨窗口同步新增卡片） */
  onCreated(callback: (profile: Profile) => void): () => void
  /** 监听 Profile 删除后的广播（跨窗口同步移除卡片、关闭相关 tab） */
  onDeleted(callback: (profileId: string) => void): () => void
  /** 监听 Profile 拖拽排序后的广播（跨窗口同步顺序，参数为新顺序的 profile id 数组） */
  onReordered(callback: (orderedIds: string[]) => void): () => void
}

/** 窗口管理接口 */
export interface WindowAPI {
  open(profileId: string): Promise<void>
  close(profileId: string): Promise<void>
  closeAll(): Promise<void>
  switchUA(profileId: string, ua: string): Promise<void>
  switchDevice(profileId: string, presetId: string): Promise<void>
  setAlwaysOnTop(profileId: string, onTop: boolean): Promise<void>
  getOpenWindowIds(): Promise<string[]>
  /**
   * 为嵌入式 webview 准备 session（单页架构专用）。
   * 设置 session 级 UA + Client Hints 拦截器，但不创建 BrowserWindow。
   * 在 <webview> 加载前调用，保证首屏即使用正确 UA。
   */
  setupSession(profileId: string): Promise<void>
}

/** 窗口控制接口（操作调用方所在窗口本身：最小化/最大化/关闭/置顶） */
export interface WindowControlAPI {
  minimize(): Promise<void>
  maximizeToggle(): Promise<boolean>
  close(): Promise<void>
  setAlwaysOnTop(onTop: boolean): Promise<boolean>
  isMaximized(): Promise<boolean>
  /** 查询当前窗口的实际置顶状态（win.isAlwaysOnTop()，非持久化值） */
  isAlwaysOnTop(): Promise<boolean>
  getBounds(): Promise<{ x?: number; y?: number; width: number; height: number }>
  /** 将指定标签脱离当前窗口，弹出为独立窗口 */
  detachTab(tabId: string): Promise<void>
  /**
   * 自定义边缘拖拽 resize。
   * 渲染层在窗口边缘按下并拖动时，向主进程发送新的目标 bounds，
   * 主进程调用 win.setBounds 完成 resize。
   */
  resize(bounds: { x?: number; y?: number; width: number; height: number }): Promise<void>
  /** 切换全屏（保留接口，当前无热键绑定） */
  toggleFullscreen(): Promise<boolean>
  /** 确定性退出全屏：仅在全屏时退出，不做 toggle */
  exitFullscreen(): Promise<boolean>
  /** 云游戏备用方案：把系统光标重置到指定屏幕坐标（指针锁定不可用时的光标居中） */
  setCursor(x: number, y: number): Promise<{ ok: boolean; error?: string }>
  /**
   * 动态设置当前窗口的最小尺寸（用于 UI 比例变化时重新约束窗口尺寸）。
   * 主进程通过 BrowserWindow.setMinimumSize 设置调用方所在窗口。
   */
  setMinimumSize(width: number, height: number): Promise<void>
  /**
   * 获取当前窗口的最小尺寸（主进程 BrowserWindow.getMinimumSize）。
   * 用于 resize 拖拽时动态获取真实下限，而非硬编码。
   */
  getMinimumSize(): Promise<{ width: number; height: number }>
  /**
   * 监听最大化状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
   * 返回取消监听的函数。
   */
  onMaximizeToggled(callback: (isMaximized: boolean) => void): () => void
  /**
   * 监听全屏状态变更事件（主进程全屏切换时通知渲染层，用于移除窗口圆角）。
   * 返回取消监听的函数。
   */
  onFullscreenToggled(callback: (isFullscreen: boolean) => void): () => void
  /**
   * 监听置顶状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
   * 返回取消监听的函数。
   */
  onPinToggled(callback: (alwaysOnTop: boolean) => void): () => void
}

/** 窗口状态持久化接口 */
export interface WindowStateAPI {
  /** 读取窗口状态（按 windowId） */
  get(windowId: string): Promise<WindowStateData | null>
  /** 保存窗口状态（整体覆盖） */
  save(windowId: string, state: WindowStateData): Promise<void>
  /** 读取所有脱离窗口的 id 列表 */
  listDetachedWindowIds(): Promise<string[]>
  /** 删除指定窗口状态（脱离窗口关闭时清理） */
  remove(windowId: string): Promise<void>
}

/** 标签管理接口（更新标题/顺序，由渲染进程调用并触发持久化） */
export interface TabAPI {
  /** 更新标签标题 */
  updateTitle(windowId: string, tabId: string, title: string): Promise<void>
  /** 更新标签 URL */
  updateUrl(windowId: string, tabId: string, url: string): Promise<void>
  /** 更新标签首页地址 */
  updateHomeUrl(windowId: string, tabId: string, homeUrl: string): Promise<void>
  /** 主→渲染：窗口快捷键兜底请求（主窗口无该 Profile 标签时，要求渲染层创建并返回 tabId） */
  onEnsureAndDetach(callback: (profileId: string) => void): () => void
  /** 渲染→主：回复兜底请求结果（tabId 或 null） */
  reportEnsureAndDetachResult(payload: { profileId: string; tabId: string | null }): void
}

/** 设备预设接口 */
export interface PresetsAPI {
  list(): Promise<DevicePreset[]>
  get(id: string): Promise<DevicePreset | null>
  save(preset: DevicePreset): Promise<DevicePreset>
  delete(id: string): Promise<void>
  update(id: string, patch: Partial<DevicePreset>): Promise<DevicePreset>
}

// ── ElectronAPI 根级窗口/标签/编辑器成员（就近归类） ──

/** 主进程 → 渲染层：拦截 webview 弹窗后新建标签页 */
export type OnNewTabCallback = (url: string, windowId: string) => void

/**
 * 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
 * 将 URL + guest webContents id 发回渲染层，由渲染层在匹配的当前 webview 内导航，
 * 实现页面内跳转而非弹出新窗口）。返回取消监听的函数。
 */
export type OnWebviewPopupUrlCallback = (payload: { url: string; webContentsId: number }) => void

/** 窗口重新显示/聚焦到前台（主→渲染：聚焦输入框） */
export type OnWindowShownCallback = () => void

/** 窗口隐藏（主→渲染：自动收起展开的面板） */
export type OnWindowHiddenCallback = () => void

/** 主→渲染：弹窗被连续拦截 N 次后提示用户加白 */
export type OnPopupDeniedCallback = (data: { origin: string; count: number }) => void

/**
 * 打开 AI 应用编辑窗口（多例，按 windowKey 单例）。
 * - 编辑模式：传 profileId 精确定位 Profile（支持同一平台多实例）
 * - 新建模式：mode='create'，表单空白，用户自由配置后创建
 */
export type OpenAiAppEditorFn = (opts: {
  platformId?: string
  profileId?: string
  mode?: 'edit' | 'create'
}) => Promise<void>

/** 打开设置独立窗口（单例，左导航+右内容布局） */
export type OpenSettingsWindowFn = () => Promise<void>

/**
 * 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）。
 * 可选 providerId：若提供则切换到对应自定义供应商的对话页。
 */
export type OpenAdvancedPanelWindowFn = (providerId?: string) => Promise<void>

/** 切换 进阶面板显隐（单例） */
export type ToggleAdvancedPanelWindowFn = () => Promise<void>

/** 主→渲染：单例窗口复用时通知切换 tab/provider */
export type OnAdvancedPanelNavigateCallback = (
  callback: (payload: { tab: string; providerId?: string }) => void,
) => () => void

/** 浏览器窗口（v0.0.9：多标签浏览器） */
export type BrowserAPIRef = import('../browser.types.js').BrowserWindowState
