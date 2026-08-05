// browser.types.ts — 多标签浏览器窗口（v0.0.9）类型定义
//
// 浏览器窗口是独立窗口的升级版：Chrome 风格多标签 + 地址栏 + 下载管理 +
// 搜索历史 + region 感知代理。与主窗口共享 AI 应用配置，但使用独立 session
// partition（persist:${profileId}-browser）实现代理隔离，登录态通过 Cookie
// 复制继承。

/** 浏览器标签状态 */
export interface BrowserTabState {
  /** 标签唯一 id（UUID） */
  id: string
  /** 关联的 Profile id（决定 session partition 与 UA） */
  profileId: string
  /** 标签标题（页面 title 自动更新） */
  title: string
  /** 当前 URL */
  url: string
  /** 站点 favicon（data URL 或 http URL，可选） */
  favicon?: string
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否可后退 */
  canGoBack: boolean
  /** 是否可前进 */
  canGoForward: boolean
  /** 在标签栏中的排序（从 0 开始） */
  order: number
  /** 标签来源：initial=脱离时从导航历史恢复 / new=用户新建 / external=外部链接打开 / settings=内部设置页 / bookmark-manager=书签管理器 */
  source: 'initial' | 'new' | 'external' | 'settings' | 'bookmark-manager'
  /** 标签种类：home=AI应用首页 / web=派生网页。决定标签栏图标与默认行为 */
  kind: 'home' | 'web'
  /** 主窗口父标签 id（脱离时记录原 TabState.id，用于跨窗口归属查询） */
  parentTabId?: string
  /** 是否固定标签（固定标签排在左侧、占用最小宽度、不显示关闭按钮） */
  pinned?: boolean
  /** 是否被用户主动静音（audible 为页面实际在播放音频） */
  muted?: boolean
  /** 页面当前是否在播放音频（webview media 事件驱动） */
  audible?: boolean
  /** 站点独立权限（轻量，仅本标签生效） */
  sitePermissions?: {
    /** 强制静音 */
    mute?: boolean
    /** 禁止下载 */
    blockDownload?: boolean
    /** 禁止通知 */
    blockNotification?: boolean
  }
}

/** 浏览器窗口状态（持久化到 browser-windows.json） */
export interface BrowserWindowState {
  /** 窗口 id（UUID） */
  windowId: string
  /** 绑定的 Profile id（整个窗口共享一个 Profile/session） */
  profileId: string
  /** 窗口位置与尺寸（最大化时忽略） */
  bounds: { x?: number; y?: number; width: number; height: number }
  /** 是否最大化（默认 true） */
  isMaximized: boolean
  /** 是否全屏 */
  isFullscreen: boolean
  /** 是否置顶 */
  alwaysOnTop: boolean
  /** 当前激活的标签 id（null=无标签） */
  activeTabId: string | null
  /** 标签列表（顺序即展示顺序） */
  tabs: BrowserTabState[]
  /** 书签栏是否显示（默认 true） */
  bookmarkBarVisible?: boolean
  /** 主窗口父标签 id 快照（脱离时从 TabState.id 记录，用于跨窗口归属查询） */
  parentTabId?: string
  /** AI 平台 id 快照（书签来源展示用） */
  aiPlatformId?: string
  /** AI 平台名称快照（避免 Profile 删除后丢失来源信息） */
  platformName?: string
}

/** 导航历史条目（内存中，不持久化；重启后清空） */
export interface NavHistoryEntry {
  url: string
  title: string
  timestamp: number
}

/** 浏览器下载记录（SQLite 持久化） */
export interface BrowserDownloadRecord {
  id: string
  windowId: string
  profileId: string
  url: string
  filename: string
  savePath: string
  state: 'progressing' | 'completed' | 'interrupted' | 'cancelled'
  totalBytes: number
  receivedBytes: number
  startTime: number
  endTime?: number
  mimeType?: string
}

/** 搜索历史条目（SQLite 持久化） */
export interface SearchHistoryEntry {
  id: string
  profileId: string
  query: string
  url: string
  timestamp: number
}
