// settings.api.ts — AppSettings / Onboarding / BlockRules / Fingerprint / PlatformCapabilities 接口

import type { BlockRule } from '../block-rules.types.js'
import type { PromptTemplate } from '../chat.types.js'
import type { PlatformCapabilities } from '../../utils/platform-info.js'

// re-export 供渲染进程通过 shared/types 桶导出使用
export type { PlatformCapabilities }

/** 应用全局设置 */
export interface AppSettings {
  /** 是否隐藏国外模型/平台 */
  hideForeignModels: boolean
  /** 顶部标签栏是否默认收起（hover 才展开） */
  tabBarCollapsed: boolean
  /** 代理模式 */
  proxyMode: 'system' | 'direct' | 'custom'
  /** 自定义代理地址 */
  customProxy: string
  /** 自定义代理用户名（可选） */
  proxyUsername: string
  /** 自定义代理密码（可选） */
  proxyPassword: string
  /** 代理绕过列表（逗号分隔域名） */
  proxyBypass: string
  /** 用户手动隐藏的 AI 平台 id 列表（与一键隐藏国外模型叠加生效） */
  hiddenPlatforms: string[]
  /** Enter 键默认发送消息（Shift+Enter 换行），关闭后 Enter 换行 */
  enterToSend: boolean
  /** 默认桌面端 UA 对应的设备预设 id */
  defaultDesktopUaPreset: string
  /** 默认移动端 UA 对应的设备预设 id */
  defaultMobileUaPreset: string
  /** 关闭按钮行为：close=直接关闭退出 / minimize=最小化到托盘 */
  closeBehavior: 'close' | 'minimize'
  /** 开机自启动 */
  autoLaunch: boolean
  /** 静默启动（启动后隐藏到托盘，仅 autoLaunch=true 时有意义） */
  silentStart: boolean
  /** UI 比例：small=紧凑 / medium=中档（默认）/ large=大号 */
  uiScale: 'small' | 'medium' | 'large'
  /** 启动时默认打开：home=平台首页 / lastConversation=最近对话地址（无历史时回退首页） */
  startupOpen: 'home' | 'lastConversation'
  /** 引导是否已完成（首次启动为 false，完成引导后置 true，后续启动不再弹引导窗） */
  onboardingCompleted: boolean
  /** 顶栏可自定义显隐的按钮组（appSwitcher/menu/刷新/最小化/最大化/关闭始终显示） */
  topBarVisibleButtons: TopBarButtonGroup[]
  /** 点击已打开应用时的行为：switch=切换到该标签（默认）/ close=关闭该标签 */
  appClickBehavior: 'switch' | 'close'
  /** 弹窗白名单：URL 前缀数组，匹配的 URL 允许弹独立 BrowserWindow（登录/OAuth/验证页等） */
  popupWhitelist: string[]
  /** 缓存自动清理频率：never=不自动 / daily / weekly / monthly */
  cacheAutoClean: 'never' | 'daily' | 'weekly' | 'monthly'
  /** 上次缓存清理时间戳（ms），用于自动清理触发判定 */
  lastCacheCleanAt: number
  /** 下载目录绝对路径；空串=使用 app.getPath('downloads') */
  downloadDir: string
  /** 下载行为：ask=每次弹保存框 / auto=自动保存到 downloadDir */
  downloadBehavior: 'ask' | 'auto'
  /** 连续 Alt+Space 触发恢复主窗口默认位置的次数阈值（默认 6） */
  altSpaceResetThreshold: number
  /** 代理失败兜底：custom 代理加载失败时自动切换到兜底模式（默认关闭） */
  proxyFallbackEnabled: boolean
  /** 代理失败兜底模式：direct=直连 / system=系统代理 */
  proxyFallbackMode: 'direct' | 'system'
  /** 使用统计与操作日志：记录启动时间 + data-name 点击日志到 SQLite（默认开，完全本地存储） */
  usageTrackingEnabled: boolean
  /** 需求 7：Cookie 弹窗白名单（自动点击"接受全部"按钮） */
  cookieWhitelist: string[]
  /** 需求 7：Cookie 弹窗黑名单（直接隐藏所有 cookie 弹窗） */
  cookieBlacklist: string[]
  /** 需求 7：同域名 Cookie 弹窗冷却时间（ms），冷却期内不重复处理 */
  cookiePopupCooldownMs: number
  /** 需求 7：Cookie 弹窗自动处理总开关（默认 true） */
  cookieHandlerEnabled: boolean
  /** v0.5.2 R-3：进阶面板默认打开的 tab（Alt+Q 入口） */
  defaultAdvancedPanelTab: 'chat' | 'whiteboard' | 'notes'
  /** 白板应用层侧边栏是否可见（默认 false；Excalidraw 无内置多页面 UI，sidebar 是多白板管理入口） */
  whiteboardSidebarVisible: boolean
  /** 关闭所有广告屏蔽规则：开启后所有单独配置的屏蔽规则均不生效（默认 false） */
  disableAllBlockRules: boolean
  /** 灵感笔记侧边栏宽度（默认 160px，范围 120-400） */
  notesSidebarWidth: number
  /** 灵感笔记侧边栏是否收起 */
  notesSidebarCollapsed: boolean
  /** 灵感笔记是否恢复上次光标位置（默认 true） */
  notesRestoreCursor: boolean
  /** 自定义对话侧边栏宽度（默认 160px，范围 120-400） */
  chatSidebarWidth: number
  /** 自定义对话侧边栏是否收起 */
  chatSidebarCollapsed: boolean
  /** 自定义对话输入框光标位置（持久化，关闭重开后恢复） */
  chatInputCursorPos: number
  /** 进阶面板标签切换快捷键（Ctrl+1/2/3、Alt+1/2/3、Ctrl+Tab，默认 true） */
  advancedPanelTabSwitchShortcuts: boolean
  /** 白板侧边栏宽度（默认 130px） */
  whiteboardSidebarWidth: number
  /** 白板侧边栏是否收起 */
  whiteboardSidebarCollapsed: boolean
  /** 浏览器标签累积持久化模式：memory=内存模式（默认，主窗口关闭清空）/ persistent=持久化到磁盘 */
  browserTabPersistence: 'memory' | 'persistent'
  /** 默认搜索引擎配置（G1：地址栏非 URL 输入时使用，urlTemplate 使用 {query} 占位符） */
  defaultSearchEngine: {
    name: string
    urlTemplate: string
  }
}

/** 顶栏可显隐的按钮组标识（appSwitcher/menu/刷新始终显示，不在此列） */
export type TopBarButtonGroup =
  | 'uaToggle'
  | 'navBack'
  | 'navForward'
  | 'navHome'
  | 'themeToggle'
  | 'pinToggle'

/** 全部可自定义的顶栏按钮组（默认全选；appSwitcher/menu/刷新始终显示） */
export const ALL_TOP_BAR_BUTTON_GROUPS: TopBarButtonGroup[] = [
  'uaToggle',
  'navBack',
  'navForward',
  'navHome',
  'themeToggle',
  'pinToggle',
]

/** 应用全局设置 API */
export interface AppSettingsAPI {
  /** 读取应用全局设置 */
  get(): Promise<AppSettings>
  /** 更新应用全局设置（合并 patch） */
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 测试代理连通性（返回 ok/latencyMs/message） */
  testProxy(): Promise<{ ok: boolean; latencyMs?: number; message: string }>
  /** 将当前代理配置即时应用到所有 session（无需重启） */
  applyProxy(): Promise<void>
  /**
   * 代理失败兜底：webview 加载失败时代理错误码触发，临时切换到兜底模式。
   * 返回 { switched, mode } —— switched=true 表示已切换，mode 为切换到的模式。
   */
  applyProxyFallback(): Promise<{ switched: boolean; mode: 'direct' | 'system' | null }>
  /** 测试指定 Profile 的代理连通性 */
  testProfileProxy(profileId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }>
  /** 将 Profile.proxyConfig 即时应用到其 session（无需重启） */
  applyProfileProxy(profileId: string): Promise<void>
  /** Profile 级代理失败兜底（浏览器窗口 webview 加载失败时触发） */
  applyProfileProxyFallback(profileId: string): Promise<{ switched: boolean; mode: 'direct' | 'system' | null }>
  /**
   * 保存/清除指定 Profile 的浏览器窗口脱离/回归快捷键。
   * 主进程会调用 reregisterProfileShortcuts() 重注册全局快捷键。
   * @param accelerator accelerator 字符串，传 null 清除快捷键
   */
  setProfileShortcut(profileId: string, accelerator: string | null): Promise<unknown>
  /** 清除所有用户数据（恢复出厂设置），完成后应用自动重启 */
  clearAllData(): Promise<boolean>
  /** 选择导出文件保存路径（弹出系统保存对话框） */
  selectExportPath(): Promise<string | null>
  /** 选择导入文件（弹出系统打开对话框） */
  selectImportFile(): Promise<string | null>
  /**
   * 导出数据到指定路径（细粒度控制）
   * @param targetPath 保存路径
   * @param options 导出选项（基础数据 / 登录凭据 / 应用数据 / 离线缓存）
   */
  exportData(
    targetPath: string,
    options: {
      basicData: boolean;
      cookies: boolean;
      indexedDB: boolean;
      cache: boolean;
    },
  ): Promise<{ success: boolean; filePath?: string; error?: string }>
  /** 从 zip 文件导入所有数据（导入后应用自动重启） */
  importData(zipPath: string): Promise<{ success: boolean; error?: string }>
  /**
   * 估算导出各类别体积（字节）
   * 返回 basicData/cookies/indexedDB/cache 各项大小，
   * total 由渲染层按选中项累加
   */
  estimateExportSizes(): Promise<{
    basicData: number;
    cookies: number;
    indexedDB: number;
    cache: number;
  }>
  /** 打开数据导出独立窗口（细粒度选择 + 体积提示，单例） */
  openExportWindow(): Promise<void>
  /** 清理缓存数据（仅缓存目录与 session cache，保留登录态） */
  cleanCache(): Promise<{ cleanedBytes: number }>
  /** 估算当前缓存体积（字节） */
  estimateCacheSize(): Promise<number>
  /** 选择下载目录（弹出系统目录选择对话框），返回选中路径或 null */
  selectDownloadDir(): Promise<string | null>
  /** 在系统文件管理器中打开下载目录 */
  openDownloadDir(): Promise<void>
  /** 读取拖拽文件并以 data URL 形式返回（用于跨 webview 边界传递文件内容） */
  dropFiles(filePaths: string[]): Promise<Array<{ filename: string; dataUrl: string; mime: string; size: number }>>
  /** 监听下载完成事件（主进程 → 渲染层：filename + path） */
  onDownloadDone(callback: (info: { filename: string; path: string }) => void): () => void
}

/** 引导 API（首次启动引导窗 + 重新查看入口） */
export interface OnboardingAPI {
  /** 打开引导窗（单例，已存在则聚焦） */
  show(): Promise<void>
  /** 查询引导是否已完成 */
  isCompleted(): Promise<boolean>
  /** 完成引导：合并保存 patch 到 app-settings，标记 onboardingCompleted=true，关闭引导窗，显示主窗口 */
  complete(patch?: Partial<AppSettings>): Promise<void>
}

/** 指纹脚本接口（单页架构：渲染进程通过 IPC 取脚本注入 webview） */
export interface FingerprintAPI {
  /** 获取指定 Profile 的指纹注入脚本字符串（IIFE） */
  getScript(profileId: string): Promise<string>
}

/** 页面组件屏蔽规则接口 */
export interface BlockRulesAPI {
  list(): Promise<BlockRule[]>
  save(rule: BlockRule): Promise<BlockRule>
  delete(id: string): Promise<void>
  update(id: string, patch: Partial<BlockRule>): Promise<BlockRule | null>
}

/** 平台能力查询接口（设置页显示权限状态） */
export interface PlatformCapabilitiesAPI {
  /** 获取当前平台的能力矩阵（安全存储、全局快捷键、辅助功能权限等） */
  get(): Promise<PlatformCapabilities>
}

// ── ElectronAPI 根级设置/UI 成员（就近归类） ──

/** 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后通知各窗口重新计算最小尺寸） */
export type OnUiScaleChangedCallback = (callback: (uiScale: 'small' | 'medium' | 'large') => void) => () => void

/** 主→渲染：应用设置变更广播（任意窗口修改设置后通知所有窗口同步） */
export type OnAppSettingsChangedCallback = (callback: (settings: AppSettings) => void) => () => void

/** 渲染→主：请求广播 UI 版本/主题变更到所有窗口 */
export type BroadcastUiVersionChangedFn = (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void

/** 主→渲染：UI 版本/主题变更广播 */
export type OnUiVersionChangedCallback = (callback: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void) => () => void

/** 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行） */
export type OnWebviewHotkeyCallback = (
  callback: (payload: {
    action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'forceRefresh' | 'newTab' | 'closeTab' | 'detachCurrent' | 'toggleFullscreen' | 'focusCycle' | 'addBookmark' | 'openHistory' | 'openDownloads' | 'focusSearch' | 'clearBrowsingData' | 'findInPage' | 'print'
    data?: unknown
  }) => void,
) => () => void

/** 主→提示词库窗口渲染：注入结果回传 */
export type OnPromptInjectResultCallback = (cb: (result: { success: boolean; platformName?: string }) => void) => () => void

/** 主窗口渲染 → 主进程：回传注入结果（主进程转发到提示词库窗口，供其显示 toast） */
export type SendPromptInjectResultFn = (result: { success: boolean; platformName?: string }) => void
