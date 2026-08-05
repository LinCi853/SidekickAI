// browser.api.ts — Browser / Bookmark / NavHistory / Hotkey 接口

import type {
  BrowserWindowState,
  BrowserDownloadRecord,
  SearchHistoryEntry,
  NavHistoryEntry,
  BrowserTabState,
} from '../browser.types.js'
import type { Bookmark, BookmarkInput, BookmarkPatch } from '../bookmark.types.js'
import type { TabState } from '../window.types.js'

/** 浏览器窗口 API（多标签浏览器窗口：状态持久化 / 搜索历史 / 下载 / 外部打开） */
export interface BrowserAPI {
  /** 读取浏览器窗口状态（按 windowId） */
  getState(windowId: string): Promise<BrowserWindowState | null>
  /** 保存浏览器窗口状态（整体覆盖） */
  saveState(windowId: string, state: BrowserWindowState): Promise<void>
  /** 在系统默认浏览器中打开 URL */
  openExternal(url: string): Promise<void>
  /** 记录一条搜索历史 */
  addSearchHistory(entry: { profileId: string; query: string; url: string }): Promise<void>
  /** 查询搜索历史（按 profileId，可选关键词过滤，按时间倒序） */
  listSearchHistory(profileId: string, keyword?: string, limit?: number): Promise<SearchHistoryEntry[]>
  /** 列出下载记录（可选按 windowId 过滤，按时间倒序） */
  listDownloads(windowId?: string, limit?: number): Promise<BrowserDownloadRecord[]>
  /** 打开已下载文件 */
  openDownloadFile(id: string): Promise<{ ok: boolean; error?: string }>
  /** 在文件管理器中显示已下载文件 */
  showDownloadInFolder(id: string): Promise<{ ok: boolean; error?: string }>
  /** 主→渲染：下载状态变化推送。返回取消监听函数。 */
  onDownloadUpdated(callback: (record: BrowserDownloadRecord) => void): () => void
  /** 主→渲染：F12 切换 DevTools（webview 焦点时主进程拦截转发）。返回取消监听函数。 */
  onToggleDevTools(callback: () => void): () => void
  /** 主→渲染：F11 切换全屏（webview 焦点时主进程拦截转发）。返回取消监听函数。 */
  onToggleFullscreen(callback: () => void): () => void
  /** 浏览器窗口关闭时，将当前标签迁移回主窗口 */
  tabMigrateBack(payload: { profileId: string; url: string; title: string; finalUrls?: Array<{ tabId: string; url: string; title: string }> }): void
  /** 主→渲染：监听浏览器标签迁移回主窗口的事件。返回取消监听函数。 */
  onTabMigrateBack(callback: (payload: { profileId: string; url: string; title: string; finalUrls?: Array<{ tabId: string; url: string; title: string }> }) => void): () => void
  /** 主→渲染：标签已脱离到浏览器窗口（载荷：profileId, newActiveTabId）。返回取消监听函数。 */
  onTabDetached(callback: (profileId: string, newActiveTabId: string | null) => void): () => void
  /** 主→渲染：标签音频状态变化（页面开始/停止播放音频）。返回取消监听函数。 */
  onTabAudioChanged(callback: (payload: { windowId: string; tabId: string; audible: boolean }) => void): () => void
  /** 跨窗口标签聚合查询（主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签） */
  queryAllTabs(): Promise<{ main: TabState[]; browsers: { windowId: string; parentTabId: string | null; profileId: string; platformName: string | null; tabs: BrowserTabState[] }[] }>
  /** 书签系统 API */
  bookmark: BookmarkAPI
}

/** 书签系统 API（v0.0.9） */
export interface BookmarkAPI {
  /** 查询书签列表（可选过滤） */
  list(filter?: { profileId?: string; barOnly?: boolean }): Promise<Bookmark[]>
  /** 新增书签；返回完整 Bookmark */
  add(input: BookmarkInput): Promise<Bookmark>
  /** 更新书签（部分字段）；返回更新后的对象 */
  update(id: string, patch: BookmarkPatch): Promise<Bookmark | undefined>
  /** 删除书签 */
  delete(id: string): Promise<void>
  /** 重排序书签栏（按 ids 顺序依次赋值 sort_order） */
  reorder(ids: string[]): Promise<void>
}

/** 导航历史 API（主窗口渲染层上报导航，脱离时聚合为浏览器初始标签） */
export interface NavHistoryAPI {
  /** 记录一次导航（内存存储，同 URL 连续去重） */
  record(profileId: string, entry: NavHistoryEntry): Promise<void>
  /** 获取某 Profile 的全部导航历史 */
  get(profileId: string): Promise<NavHistoryEntry[]>
  /** 清除某 Profile 的导航历史 */
  clear(profileId: string): Promise<void>
}

/** 内置热键动作标识 */
export type HotkeyAction =
  | 'toggleMainWindow'
  | 'toggleDetachedWindows'
  | 'backgroundVoice'

/** 热键配置（UI 展示与持久化） */
export interface HotkeyConfig {
  action: HotkeyAction
  /** 显示名称 */
  label: string
  /** accelerator 字符串 */
  accelerator: string
  /** 是否启用（false 时热键不注册、不响应） */
  enabled: boolean
}

/** 热键接口 */
export interface HotkeyAPI {
  register(accelerator: string, callback: () => void): Promise<boolean>
  unregister(accelerator: string): Promise<void>
  isRegistered(accelerator: string): Promise<boolean>
  /** 获取全部内置热键配置（供 UI 展示） */
  getAll(): Promise<HotkeyConfig[]>
  /** 设置某个内置热键（注销旧的，注册新的并持久化；返回是否注册成功） */
  set(action: HotkeyAction, accelerator: string): Promise<boolean>
  /** 启用/禁用某个内置热键（禁用时注销，启用时注册；持久化） */
  setEnabled(action: HotkeyAction, enabled: boolean): Promise<void>
  /** 开始录制热键（主进程临时注册 globalShortcut 捕获按键组合） */
  startRecording(): Promise<boolean>
  /** 停止录制热键 */
  stopRecording(): Promise<void>
  /** 监听热键录制结果（主进程 → 渲染层：录制完成后通知） */
  onRecordingResult(callback: (result: { accelerator: string; reason?: string }) => void): () => void
  /** 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前组合，用于 UI 实时显示） */
  onRecordingPartial(callback: (partial: { modifiers: string[]; key: string | null }) => void): () => void
  /** 订阅热键管理器状态变化（主进程推送：uiohook/voiceHotkey/voiceKeyPressed/polling） */
  onStatus(callback: (status: unknown) => void): () => void
}
