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
// E1：累积链接类型（与 store 中的 AccumulatedLink 结构一致）
export type { AccumulatedLink } from '../../store/accumulated-links-store.js'
import type { AccumulatedLink } from '../../store/accumulated-links-store.js'

/** 浏览器窗口关闭时迁移回主窗口的单条标签信息 */
export interface MigratedTabInfo {
  /** 主窗口父标签 id（用于在父标签右侧插入；可能为 undefined，由消费方兜底） */
  parentTabId?: string
  /** 该标签在浏览器窗口内的原排序（用于同 parentTabId 内按序插入） */
  originalOrder?: number
  /** 标签来源：'initial' | 'new' | 'external' | 'settings' | 'bookmark-manager'。
   *  'settings' 迁移后通知主窗口切换至主页，不作为主窗口主页插入 */
  source?: BrowserTabState['source']
  /** 兼容旧字段：tabId（等同于 parentTabId 或浏览器窗口内 tab id） */
  tabId?: string
  url: string
  title: string
}

/** 浏览器窗口 API（多标签浏览器窗口：状态持久化 / 搜索历史 / 下载 / 外部打开） */
export interface BrowserAPI {
  /** 读取浏览器窗口状态（按 windowId） */
  getState(windowId: string): Promise<BrowserWindowState | null>
  /** 保存浏览器窗口状态（整体覆盖） */
  saveState(windowId: string, state: BrowserWindowState): Promise<void>
  /** 在系统默认浏览器中打开 URL */
  openExternal(url: string): Promise<void>
  /**
   * 另存为：保存指定 webview（guest webContents）的当前页面到用户指定路径。
   * 主进程弹出保存对话框后以 HTMLComplete 格式保存。
   */
  savePageAs(webContentsId: number, suggestedName?: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  /**
   * 另存为：下载指定 URL（链接/图片等）到用户指定路径。
   * partition 为 webview 的 session 分区（persist:profileId），主进程在 will-download 中弹出保存对话框。
   */
  downloadAs(partition: string, url: string, suggestedFilename?: string): Promise<{ ok: boolean; error?: string }>
  /** 查看网页源代码：按 session partition 抓取原始 HTML 文本（携带登录态 Cookie） */
  viewSource(partition: string, url: string): Promise<{ ok: boolean; html?: string; contentType?: string; error?: string }>
  /** 打印预览：生成当前页面的 PDF 临时文件并返回文件路径 */
  printPreview(webContentsId: number, title?: string): Promise<{ ok: boolean; filePath?: string; title?: string; error?: string }>
  /** 打印预览页「另存为」：把临时 PDF 复制到用户指定路径 */
  savePdfAs(sourcePath: string, suggestedName?: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  /** 删除打印预览临时文件 */
  deleteTempPdf(filePath: string): Promise<{ ok: boolean }>
  /** 网页截图：保存截图 PNG（dataURL）到用户指定路径 */
  saveCapture(dataUrl: string, suggestedName?: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  /** 云电脑模式：进入/退出（主进程挂起/恢复全局热键、同步全屏） */
  setCloudPcMode(enter: boolean): Promise<{ ok: boolean }>
  getCursorPos(): Promise<{ ok: boolean; x: number; y: number }>
  /** 主→渲染：云电脑模式状态变化（含主进程兜底退出通知）。返回取消监听函数。 */
  onCloudPcChanged(callback: (active: boolean) => void): () => void
  /** 主→渲染：云电脑模式系统级按键路由（Win/Alt+Tab 等，渲染层合成注入 guest）。返回取消监听函数。 */
  onCloudPcKeys(callback: (e: { key: string; down: boolean; alt: boolean; win: boolean }) => void): () => void
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
  /** 删除单条下载记录（仅删除记录，不删除文件） */
  deleteDownload(id: string): Promise<{ ok: boolean; error?: string }>
  /** 清空全部下载记录（可选按 windowId 过滤；仅删除记录，不删除文件） */
  clearAllDownloads(windowId?: string): Promise<{ ok: boolean; error?: string }>
  /** 主→渲染：下载状态变化推送。返回取消监听函数。 */
  onDownloadUpdated(callback: (record: BrowserDownloadRecord) => void): () => void
  /** 主→渲染：F12 切换 DevTools（webview 焦点时主进程拦截转发）。返回取消监听函数。 */
  onToggleDevTools(callback: () => void): () => void
  /** 主→渲染：F11 切换全屏（webview 焦点时主进程拦截转发）。返回取消监听函数。 */
  onToggleFullscreen(callback: () => void): () => void
  /** 浏览器窗口关闭时，将当前标签迁移回主窗口 */
  tabMigrateBack(payload: { profileId: string; url: string; title: string; finalUrls?: MigratedTabInfo[] }): void
  /** 主→渲染：监听浏览器标签迁移回主窗口的事件。返回取消监听函数。 */
  onTabMigrateBack(callback: (payload: { profileId: string; url: string; title: string; finalUrls?: MigratedTabInfo[] }) => void): () => void
  /** 主→渲染：标签已脱离到浏览器窗口（载荷：profileId, newActiveTabId）。返回取消监听函数。 */
  onTabDetached(callback: (profileId: string, newActiveTabId: string | null) => void): () => void
  /** 主→渲染：标签音频状态变化（页面开始/停止播放音频）。返回取消监听函数。 */
  onTabAudioChanged(callback: (payload: { windowId: string; tabId: string; audible: boolean }) => void): () => void
  /** 跨窗口标签聚合查询（主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签） */
  queryAllTabs(): Promise<{ main: TabState[]; browsers: { windowId: string; parentTabId: string | null; profileId: string; platformName: string | null; tabs: BrowserTabState[] }[] }>
  /** 聚焦指定浏览器窗口 */
  focusWindow(windowId: string): Promise<boolean>
  /** 书签系统 API */
  bookmark: BookmarkAPI
  /** E1：AI 应用内新窗口链接累积 API */
  accumulatedLinks: AccumulatedLinksAPI
}

/** E1：AI 应用内新窗口链接累积 API（双模式：内存 / 持久化，由设置决定） */
export interface AccumulatedLinksAPI {
  /** 添加一条累积链接 */
  add(profileId: string, url: string, title: string): Promise<void>
  /** 列出指定 Profile 的全部累积链接（按 timestamp 升序） */
  list(profileId: string): Promise<AccumulatedLink[]>
  /** 取出并清空指定 Profile 的全部累积链接（窗口初始化时消费） */
  consume(profileId: string): Promise<AccumulatedLink[]>
  /** 清空指定 Profile 的全部累积链接 */
  clear(profileId: string): Promise<void>
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
  /** 记录一次导航（SQLite 持久化 + 内存双写，同 URL 连续去重） */
  record(profileId: string, entry: NavHistoryEntry): Promise<void>
  /** 获取某 Profile 的全部导航历史 */
  get(profileId: string): Promise<NavHistoryEntry[]>
  /** 清除某 Profile 的导航历史 */
  clear(profileId: string): Promise<void>
  /** 分页查询导航历史（按时间倒序；profileId 省略时跨 Profile 聚合） */
  list(profileId: string | undefined, page: number, pageSize: number): Promise<NavHistoryEntry[]>
  /** 关键词搜索导航历史（URL / title 模糊匹配；profileId 省略时跨 Profile 聚合） */
  search(profileId: string | undefined, keyword: string): Promise<NavHistoryEntry[]>
  /** 删除单条导航历史 */
  delete(id: string): Promise<void>
  /** 清空全部导航历史（可选按 profileId 过滤） */
  clearAll(profileId?: string): Promise<void>
}

/** 内置热键动作标识 */
export type HotkeyAction =
  | 'toggleMainWindow'
  | 'toggleDetachedWindows'
  | 'backgroundVoice'
  | 'toggleVoice'

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
