// electron/store/app-settings-store.ts — 应用全局设置持久化存储 + IPC 注册
//
// 决策 0.4（既有需求）：设置尽量入库。应用设置现持久化到 SQLite settings.db 的
// app_settings 表（首次启动自动把旧 app-settings.json 迁入，旧文件改名 .bak）。
// 当前字段：
//   - hideForeignModels: boolean  是否隐藏国外模型/平台（默认 true，安装后仅显示国内可用服务）
//   - tabBarCollapsed: boolean    顶部标签栏是否默认收起（hover 展开），默认 true
//   - proxyMode: 'system' | 'direct' | 'custom'  代理模式（system=系统代理 / direct=直连 / custom=自定义）
//   - customProxy: string         自定义代理地址（proxyMode=custom 时有效，空字符串=不使用自定义代理）
//   - proxyUsername/proxyPassword/proxyBypass: 自定义代理的认证与绕过列表
//

import { ipcMain, BrowserWindow, app, session, dialog, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS, ALL_TOP_BAR_BUTTON_GROUPS, type TopBarButtonGroup } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { isPortableMode, getStoreCwd } from './store-paths.js'
import { getAppSettingsTable, migrateAppSettingsJson } from './module-state-store.js'
import { getHotkeyManagerInstance } from '../hotkey/manager.js'

// ===== SQLite 持久化（settings.db / app_settings 表） =====

/** 内存缓存（进程内读写即时生效，writeSettingsRaw 同步落库） */
let settingsCache: AppSettings | null = null

/** 读原始设置（含默认值兜底与一次性旧 JSON 迁移） */
function readSettingsRaw(): AppSettings {
  migrateAppSettingsJson()
  if (!settingsCache) {
    const raw = getAppSettingsTable().get('appSettings')
    if (raw) {
      try {
        settingsCache = JSON.parse(raw) as AppSettings
        console.log('[app-settings] 从 settings.db 加载设置, onboardingCompleted=', settingsCache.onboardingCompleted)
      } catch (err) {
        console.error('[app-settings] 解析 settings.db 失败，回退默认值:', err)
        settingsCache = { ...DEFAULT_SETTINGS }
      }
    } else {
      settingsCache = { ...DEFAULT_SETTINGS }
      console.log('[app-settings] 首次启动，使用默认设置, onboardingCompleted=', settingsCache.onboardingCompleted)
      getAppSettingsTable().set('appSettings', JSON.stringify(settingsCache))
    }
  }
  return settingsCache
}

/** 写回原始设置（缓存 + 落库） */
function writeSettingsRaw(next: AppSettings): void {
  settingsCache = next
  getAppSettingsTable().set('appSettings', JSON.stringify(next))
}

/** 测试用：重置内存缓存（不落库） */
export function resetSettingsCacheForTest(): void {
  settingsCache = null
}

// 持久化存储实例（写入 app-settings.json）
export interface AppSettings {
  /** 是否隐藏国外模型/平台 */
  hideForeignModels: boolean
  /** 顶部标签栏是否默认收起（hover 才展开），关闭则常驻显示 */
  tabBarCollapsed: boolean
  /** 代理模式：system=系统代理 direct=直连 custom=自定义 */
  proxyMode: 'system' | 'direct' | 'custom'
  /** 自定义代理地址（proxyMode=custom 时有效） */
  customProxy: string
  /** 自定义代理用户名（可选） */
  proxyUsername: string
  /** 自定义代理密码（可选） */
  proxyPassword: string
  /** 代理绕过列表（逗号分隔域名，不走代理） */
  proxyBypass: string
  /** 用户手动隐藏的 AI 平台 id 列表（与一键隐藏国外模型叠加生效，设置面板仍可见以便管理） */
  hiddenPlatforms: string[]
  /** Enter 键默认发送消息（Shift+Enter 换行），关闭后 Enter 换行 */
  enterToSend: boolean
  /** 默认桌面端 UA 对应的设备预设 id（用户从设备预设中自选） */
  defaultDesktopUaPreset: string
  /** 默认移动端 UA 对应的设备预设 id（用户从设备预设中自选） */
  defaultMobileUaPreset: string
  /** 关闭按钮行为：close=直接关闭退出 / minimize=最小化到托盘（默认托盘模式，不退出应用） */
  closeBehavior: 'close' | 'minimize'
  /** 开机自启动 */
  autoLaunch: boolean
  /** 静默启动（启动后隐藏到托盘，仅 autoLaunch=true 时有意义） */
  silentStart: boolean
  /** UI 比例：small=紧凑 / medium=中档（默认）/ large=大号，控制字体和组件大小 */
  uiScale: 'small' | 'medium' | 'large'
  /** 启动时默认打开：home=平台首页 / lastConversation=最近对话地址（无历史时回退首页） */
  startupOpen: 'home' | 'lastConversation'
  /** 引导是否已完成（首次启动为 false，完成引导后置 true，后续启动不再弹引导窗） */
  onboardingCompleted: boolean
  /** 顶栏默认显示的按钮组（未列出的隐藏；最小化/最大化/关闭三按钮始终显示） */
  topBarVisibleButtons: TopBarButtonGroup[]
  /** 点击已打开应用时的行为：switch=切换到该标签（默认）/ close=关闭该标签 */
  appClickBehavior: 'switch' | 'close'
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
  /** 需求 7：Cookie 弹窗白名单（自动点击"接受全部"），默认含 google.com / openai.com */
  cookieWhitelist: string[]
  /** 需求 7：Cookie 弹窗黑名单（直接隐藏所有 cookie 弹窗） */
  cookieBlacklist: string[]
  /** 需求 7：同域名重复弹窗冷却时间（ms），默认 60000（60 秒） */
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
  /** 弹窗白名单：URL 前缀数组，匹配的 URL 允许弹独立 BrowserWindow（登录/OAuth/验证页等） */
  popupWhitelist: string[]
  /** 浏览器标签累积持久化模式：memory=内存模式（默认，主窗口关闭清空）/ persistent=持久化到磁盘 */
  browserTabPersistence: 'memory' | 'persistent'
  /** 默认搜索引擎配置（G1：地址栏非 URL 输入时使用的搜索引擎，urlTemplate 使用 {query} 占位符） */
  defaultSearchEngine: {
    name: string
    urlTemplate: string
  }
}

const DEFAULT_SETTINGS: AppSettings = {
      hideForeignModels: true,
      tabBarCollapsed: true,
      proxyMode: 'system',
      customProxy: '',
      proxyUsername: '',
      proxyPassword: '',
      proxyBypass: '',
      hiddenPlatforms: [],
      enterToSend: true,
      defaultDesktopUaPreset: 'win-chrome-125',
      defaultMobileUaPreset: 'iphone-15-pro-safari',
      // 安装版默认最小化到托盘，便携版默认直接关闭
      closeBehavior: isPortableMode() ? 'close' : 'minimize',
      autoLaunch: false,
      silentStart: false,
      uiScale: 'medium',
      startupOpen: 'lastConversation',
      onboardingCompleted: false,
      topBarVisibleButtons: ['navBack', 'navForward', 'navHome', 'pinToggle'],
      // 点击已打开应用时默认切换到该标签（不关闭），需用户主动改为 close 才关闭
      appClickBehavior: 'switch',
      // 缓存清理：默认不自动清理（用户主动触发），首次启动 lastCacheCleanAt=0
      cacheAutoClean: 'never',
      lastCacheCleanAt: 0,
      // 下载：默认使用系统下载目录，每次弹保存框
      downloadDir: '',
      downloadBehavior: 'ask',
      // Alt+Space 连续触发恢复窗口位置：默认 6 次（时间窗口随阈值线性放大）
      altSpaceResetThreshold: 6,
      // 代理失败兜底：默认关闭，符合用户要求"新增一个默认关闭的设置"
      proxyFallbackEnabled: false,
      proxyFallbackMode: 'direct',
      // 使用统计与操作日志：默认开启，完全本地存储，用户可在设置中关闭
      usageTrackingEnabled: true,
      // 需求 7：Cookie 弹窗处理默认配置
      cookieWhitelist: ['google.com', 'openai.com'],
      cookieBlacklist: [],
      cookiePopupCooldownMs: 60000,
      cookieHandlerEnabled: true,
      // v0.5.2 R-3：进阶面板默认打开的 tab
      defaultAdvancedPanelTab: 'chat',
      // 白板应用层侧边栏默认隐藏（单白板模式；如需管理多白板可在设置中开启）
      whiteboardSidebarVisible: false,
      // 关闭所有广告屏蔽规则：默认关闭（即默认启用屏蔽规则）
      disableAllBlockRules: false,
      // 灵感笔记侧边栏：默认 160px 宽，未收起
      notesSidebarWidth: 160,
      notesSidebarCollapsed: false,
      // 灵感笔记恢复光标位置：默认开启
      notesRestoreCursor: true,
      // 自定义对话侧边栏：默认 130px 宽，未收起
      chatSidebarWidth: 130,
      chatSidebarCollapsed: false,
      // 自定义对话输入框光标位置：默认 0（行首）
      chatInputCursorPos: 0,
      // 进阶面板标签切换快捷键：默认开启
      advancedPanelTabSwitchShortcuts: true,
      // 白板侧边栏：默认 130px 宽，未收起
      whiteboardSidebarWidth: 130,
      whiteboardSidebarCollapsed: false,
      // 弹窗白名单：默认为空（登录域白名单硬编码在 helpers.ts LOGIN_POPUP_WHITELIST）
      popupWhitelist: [],
      // 浏览器标签累积持久化：默认内存模式（主窗口关闭清空），persistent=持久化到磁盘可重启恢复
      browserTabPersistence: 'memory',
      // G1：默认搜索引擎（Bing），地址栏非 URL 输入时使用
      defaultSearchEngine: { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' },
}

/** 读取应用设置 */
export function getAppSettings(): AppSettings {
  const s = { ...readSettingsRaw() }
  // 迁移旧的 'navigation' 组到拆分后的 'navBack'/'navForward'/'navHome'
  const raw = (s.topBarVisibleButtons ?? []) as string[]
  const migrated: string[] = []
  for (const g of raw) {
    if (g === 'navigation') {
      migrated.push('navBack', 'navForward', 'navHome')
    } else {
      migrated.push(g)
    }
  }
  // 过滤已废弃的按钮组（appSwitcher/menu 已改为常驻，不再可自定义）
  const valid = new Set<TopBarButtonGroup>(ALL_TOP_BAR_BUTTON_GROUPS)
  s.topBarVisibleButtons = migrated.filter((g) => valid.has(g as TopBarButtonGroup)) as TopBarButtonGroup[]
  // 兼容旧版本设置文件：缓存清理与下载相关字段可能不存在
  s.cacheAutoClean = s.cacheAutoClean ?? 'never'
  s.lastCacheCleanAt = s.lastCacheCleanAt ?? 0
  s.downloadDir = s.downloadDir ?? ''
  s.downloadBehavior = s.downloadBehavior ?? 'ask'
  s.altSpaceResetThreshold = s.altSpaceResetThreshold ?? 6
  // 兼容旧版本设置文件：代理失败兜底字段可能不存在
  s.proxyFallbackEnabled = s.proxyFallbackEnabled ?? false
  s.proxyFallbackMode = s.proxyFallbackMode ?? 'direct'
  // 兼容旧版本设置文件：使用统计字段可能不存在
  s.usageTrackingEnabled = s.usageTrackingEnabled ?? true
  // 兼容旧版本设置文件：需求 7 Cookie 弹窗处理字段可能不存在
  s.cookieWhitelist = s.cookieWhitelist ?? ['google.com', 'openai.com']
  s.cookieBlacklist = s.cookieBlacklist ?? []
  s.cookiePopupCooldownMs = s.cookiePopupCooldownMs ?? 60000
  s.cookieHandlerEnabled = s.cookieHandlerEnabled ?? true
  // v0.5.2 R-3：兼容旧版本设置文件
  s.defaultAdvancedPanelTab = s.defaultAdvancedPanelTab ?? 'chat'
  // 白板应用层侧边栏：老用户无此字段时默认隐藏
  s.whiteboardSidebarVisible = s.whiteboardSidebarVisible ?? false
  // 关闭所有广告屏蔽规则：老用户无此字段时默认 false（即启用屏蔽规则）
  s.disableAllBlockRules = s.disableAllBlockRules ?? false
  // 灵感笔记侧边栏宽度/收起：老用户无此字段时使用默认值
  s.notesSidebarWidth = s.notesSidebarWidth ?? 160
  s.notesSidebarCollapsed = s.notesSidebarCollapsed ?? false
  s.notesRestoreCursor = s.notesRestoreCursor ?? true
  // 自定义对话侧边栏宽度/收起：老用户无此字段时使用默认值
  s.chatSidebarWidth = s.chatSidebarWidth ?? 130
  s.chatSidebarCollapsed = s.chatSidebarCollapsed ?? false
  s.chatInputCursorPos = s.chatInputCursorPos ?? 0
  s.advancedPanelTabSwitchShortcuts = s.advancedPanelTabSwitchShortcuts ?? true
  s.whiteboardSidebarWidth = s.whiteboardSidebarWidth ?? 130
  s.whiteboardSidebarCollapsed = s.whiteboardSidebarCollapsed ?? false
  // 兼容旧版本设置文件：默认 UA 预设字段可能不存在
  s.defaultDesktopUaPreset = s.defaultDesktopUaPreset || 'win-chrome-125'
  s.defaultMobileUaPreset = s.defaultMobileUaPreset || 'iphone-15-pro-safari'
  // 兼容旧版本：浏览器标签累积持久化模式
  s.browserTabPersistence = s.browserTabPersistence ?? 'memory'
  // G1：兼容旧版本设置文件，默认搜索引擎字段可能不存在
  s.defaultSearchEngine = s.defaultSearchEngine ?? { name: 'Bing', urlTemplate: 'https://www.bing.com/search?q={query}' }
  return s
}

/**
 * 清除所有用户数据（恢复出厂设置）。
 * 删除 userData / 便携 data 目录下的全部持久化文件（含设置、对话、窗口位置、登录记录等），然后重启应用。
 *
 * 完整清理流程（按顺序，每步独立 try/catch 避免单点失败阻塞）：
 *   1. 设置 isQuitting 标记 —— 绕过主窗口 closeBehavior='minimize' 的 close 事件拦截
 *   2. 中止活跃 AI 流 —— 释放 fetch 连接，避免阻塞
 *   3. 关闭 SQLite 连接 —— 释放 chat.db / chat.db-wal / chat.db-shm 文件锁
 *   4. 清理所有 session —— defaultSession + persist:<profileId> partitions
 *      （cookies/localStorage/IndexedDB/cache/auth 全部清空，删除登录痕迹）
 *   5. 销毁所有 BrowserWindow —— 使用 destroy() 而非 close()，绕过 close 事件
 *      并等待 closed 事件 + 超时兜底，确保 webContents 文件句柄释放
 *   6. 递归删除数据目录 —— 失败时逐个删除关键子项，处理 Windows 文件锁
 *   7. 重启应用 —— app.relaunch + app.exit(0)
 *
 * 注意：app.exit(0) 会跳过 before-quit 钩子，因此 main.ts 中的 hotkeyManager /
 * sttEngine / tray 等私有资源的清理逻辑不会执行。这些 native 句柄由 OS 在进程
 * 退出时自动回收，不影响数据文件清理的可靠性。
 */
export async function clearAllData(): Promise<void> {
  const dataDir = getStoreCwd() ?? app.getPath('userData')

  console.log('[app-settings] 开始清理所有用户数据:', dataDir)
  console.log('[app-settings] 重置内存缓存 settingsCache=null')
  settingsCache = null

  // 1. 设置 isQuitting 标记，绕过主窗口 closeBehavior='minimize' 拦截
  try {
    ;(app as unknown as { isQuitting?: boolean }).isQuitting = true
  } catch { /* ignore */ }

  // 2. 中止活跃 AI 流式请求（避免 fetch 阻塞进程退出）
  try {
    const { cleanupActiveStreams } = await import('../ai/handler.js')
    cleanupActiveStreams()
  } catch (err) {
    console.warn('[app-settings] 中止 AI 流失败:', err)
  }

  // 3. 关闭所有 SQLite 连接（释放 WAL 旁路文件锁，避免 fs.rmSync 失败）
  const sqliteClosures = [
    () => import('./chat-store.js').then(m => m.closeChatStore()).catch(() => {}),
    () => import('./module-state-store.js').then(m => m.closeModuleStateDb()).catch(() => {}),
    () => import('./notes-db.js').then(m => m.closeNotesDb()).catch(() => {}),
    () => import('./whiteboard-db.js').then(m => m.closeWhiteboardDb()).catch(() => {}),
    () => import('./nav-history-store.js').then(m => m.closeNavHistoryStore()).catch(() => {}),
    () => import('./bookmark-store.js').then(m => m.closeBookmarkStore()).catch(() => {}),
    () => import('./search-history-store.js').then(m => m.closeSearchHistoryStore()).catch(() => {}),
    () => import('./browser-download-store.js').then(m => m.closeBrowserDownloadStore()).catch(() => {}),
    () => import('./accumulated-links-store.js').then(m => m.accumulatedLinksStore.close()).catch(() => {}),
  ]
  for (const close of sqliteClosures) {
    try { await close() } catch { /* ignore */ }
  }

  // 4. 收集并清理所有 session（defaultSession + persist:<profileId> partitions）
  //    每个会话独立清理 cookies/localStorage/IndexedDB/cache/auth，删除登录痕迹
  const sessionsToClean: Electron.Session[] = [session.defaultSession]
  try {
    const { profileStore } = await import('./profile-store.js')
    for (const profile of profileStore.list()) {
      try {
        sessionsToClean.push(session.fromPartition(`persist:${profile.id}`))
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[app-settings] 收集 partition sessions 失败:', err)
  }

  await Promise.all(
    sessionsToClean.map(async (s) => {
      try { await s.clearStorageData() } catch { /* ignore */ }
      try { await s.clearCache() } catch { /* ignore */ }
      try { await s.clearAuthCache() } catch { /* ignore */ }
    }),
  )

  // 5. 销毁所有 BrowserWindow（destroy 而非 close，绕过 close 事件拦截）
  //    等待 closed 事件确保 webContents 文件句柄释放，带 1s 超时兜底
  await new Promise<void>((resolve) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (wins.length === 0) return resolve()
    let remaining = wins.length
    let settled = false
    const done = () => {
      if (settled) return
      remaining -= 1
      if (remaining <= 0) {
        settled = true
        resolve()
      }
    }
    for (const win of wins) {
      if (win.isDestroyed()) {
        done()
        continue
      }
      win.once('closed', done)
      try { win.destroy() } catch { done() }
    }
    // 超时兜底：1s 后强制继续（destroy 是同步的，但 OS 释放句柄可能需要时间）
    setTimeout(() => {
      if (!settled) {
        settled = true
        resolve()
      }
    }, 1000)
  })

  // 给文件系统一点时间释放底层句柄（Windows 上 destroy 后 LevelDB/IndexedDB
  // 句柄释放是异步的，立即 rmSync 可能 EBUSY）
  await new Promise((resolve) => setTimeout(resolve, 200))

  // 6. 递归删除数据目录（设置、窗口状态、AI供应商、对话历史等全部持久化数据）
  // 先直接尝试删除 settings.db（最关键：阻止重启后读到旧 onboardingCompleted）
  const settingsDbPath = path.join(dataDir, 'settings.db')
  const settingsDbWal = path.join(dataDir, 'settings.db-wal')
  const settingsDbShm = path.join(dataDir, 'settings.db-shm')
  for (const f of [settingsDbPath, settingsDbWal, settingsDbShm]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
        console.log('[app-settings] 已删除关键文件:', f)
      }
    } catch (err) {
      console.error('[app-settings] 删除关键文件失败:', f, err)
    }
  }

  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log('[app-settings] 已清除所有用户数据:', dataDir)
  } catch (err) {
    console.error('[app-settings] 递归删除失败，尝试逐个删除关键子项:', err)
    // Windows 上 GPUCache/Crashpad/SingletonLock/Partitions 等可能因句柄未完全释放而失败
    // 逐个尝试删除关键子目录和文件，最大程度清理
    const subPaths = [
      // Electron / Chromium 缓存与临时文件
      'GPUCache',
      'Crashpad',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'Session Storage',
      'Local Storage',
      'IndexedDB',
      'databases',
      'Service Worker',
      'Cache',
      'Code Cache',
      'Cookies',
      'Cookies-journal',
      'Network',
      'SharedStorage',
      'Shared Dictionary',
      'WebStorage',
      'Preferences',
      'Local State',
      'Partitions',
      'bin',
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      // settings.db（单一数据源，含 app_settings / profiles / window_states 等 KV 表）
      'settings.db',
      'settings.db-wal',
      'settings.db-shm',
      // 旧 JSON 文件（迁移前存在，迁移后为 .bak）
      'app-settings.json',
      'window-states.json',
      'ai-providers.json',
      'profiles.json',
      'voice-config.json',
      'hotkey.json',
      'prompts.json',
      'presets.json',
      'block-rules.json',
      'injection-history.json',
      'browser-downloads.json',
      'conversation-store.json',
      'accumulated-links.json',
      // 各模块独立 SQLite 数据库
      'chat.db',
      'chat.db-wal',
      'chat.db-shm',
      'notes.db',
      'notes.db-wal',
      'notes.db-shm',
      'whiteboard.db',
      'whiteboard.db-wal',
      'whiteboard.db-shm',
      'nav-history.db',
      'nav-history.db-wal',
      'nav-history.db-shm',
      'bookmarks.db',
      'bookmarks.db-wal',
      'bookmarks.db-shm',
      'search-history.db',
      'search-history.db-wal',
      'search-history.db-shm',
      'browser-downloads.db',
      'browser-downloads.db-wal',
      'browser-downloads.db-shm',
      'accumulated-links.db',
      'accumulated-links.db-wal',
      'accumulated-links.db-shm',
      // 资产目录（图片等）
      'whiteboard-assets',
      'notes-assets',
    ]
    for (const sub of subPaths) {
      try {
        fs.rmSync(path.join(dataDir, sub), { recursive: true, force: true })
        console.log('[app-settings] 逐个删除:', sub)
      } catch { /* ignore */ }
    }
    // 再次尝试删除整个目录
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
      console.log('[app-settings] 二次删除成功:', dataDir)
    } catch (err2) {
      console.error('[app-settings] 二次删除仍失败（部分文件可能被锁定，重启后由新进程清理）:', err2)
    }
  }

  // 7. 重启应用
  app.relaunch()
  app.exit(0)
}

/** 更新应用设置（合并 patch） */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = readSettingsRaw()
  const next: AppSettings = { ...current, ...patch }
  // 关闭 autoLaunch 时自动重置 silentStart=false（保持字段语义一致，避免 autoLaunch=false 但 silentStart=true 的非法态）
  if (patch.autoLaunch === false) {
    next.silentStart = false
  }
  writeSettingsRaw(next)
  // autoLaunch 或 silentStart 变化时立即同步系统注册项（避免必须重启应用才生效）
  if (patch.autoLaunch !== undefined || patch.silentStart !== undefined) {
    const ok = applyAutoLaunchSetting(next.autoLaunch, next.silentStart)
    if (!ok) {
      // 系统注册失败：回滚 store 字段并抛错，让渲染层 catch 后回滚本地 UI 状态
      writeSettingsRaw(current)
      throw new Error('应用开机自启动设置失败（系统层拒绝）')
    }
  }
  // UI 比例变化时广播到所有窗口，渲染层据此重新计算最小尺寸并调用 setMinimumSize
  if (patch.uiScale && patch.uiScale !== current.uiScale) {
    broadcastUiScaleChanged(next.uiScale)
  }
  // 广播设置变更到所有窗口（跨窗口同步：顶栏按钮、标签栏、主题、屏蔽规则等）
  broadcastAppSettingsChanged(next)
  return next
}

/**
 * 向所有 BrowserWindow 广播 UI 比例变化。
 * 各窗口渲染层收到后，根据自身窗口类型重新计算最小宽度并调用 setMinimumSize。
 */
function broadcastUiScaleChanged(uiScale: 'small' | 'medium' | 'large'): void {
  broadcastToAllWindows(IPC_CHANNELS.UI_SCALE_CHANGED, uiScale, 'app-settings')
}

/** 向所有 BrowserWindow 广播应用设置变更（跨窗口同步） */
function broadcastAppSettingsChanged(settings: AppSettings): void {
  broadcastToAllWindows(IPC_CHANNELS.APP_SETTINGS_CHANGED, settings, 'app-settings')
}

/**
 * 向所有 BrowserWindow 广播 UI 版本 / 主题变更。
 * 任意窗口修改 Oxy Design System 开关或主题模式后，通过 IPC 调用此函数通知所有窗口同步。
 */
export function broadcastUiVersionChanged(payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }): void {
  broadcastToAllWindows(IPC_CHANNELS.APP_UI_VERSION_CHANGED, payload, 'app-settings')
}

/** 注册应用设置 IPC 处理器（含代理测试与即时生效） */
export function registerAppSettingsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_SETTINGS, () => getAppSettings())
  // 渲染层请求广播 UI 版本/主题变更到所有窗口
  ipcMain.on(IPC_CHANNELS.APP_UI_VERSION_CHANGED, (_e, payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => {
    broadcastUiVersionChanged(payload)
  })
  // 渲染层请求广播 Oxy 主题色变更到所有窗口
  ipcMain.on(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, (_e, hex: string) => {
    broadcastToAllWindows(IPC_CHANNELS.APP_THEME_COLOR_CHANGED, hex, 'app-settings')
  })
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_SETTINGS, (_e, patch: Partial<AppSettings>) =>
    updateAppSettings(patch),
  )
  // 清除所有数据（恢复出厂设置）
  ipcMain.handle(IPC_CHANNELS.APP_CLEAR_ALL_DATA, async () => {
    await clearAllData()
    return true
  })
  // 代理连通性测试
  ipcMain.handle(IPC_CHANNELS.APP_TEST_PROXY, async () => {
    // 动态导入避免循环依赖
    const { testProxyConnectivity } = await import('./proxy-helper.js')
    return testProxyConnectivity()
  })
  // 代理即时生效：将当前配置应用到所有 session
  ipcMain.handle(IPC_CHANNELS.APP_APPLY_PROXY, async () => {
    const { applyProxyToAllSessions } = await import('./proxy-helper.js')
    await applyProxyToAllSessions()
  })
  // 代理失败兜底：webview 加载失败时代理错误码触发，临时切换到兜底模式
  ipcMain.handle(IPC_CHANNELS.APP_PROXY_FALLBACK, async () => {
    const { applyProxyFallback } = await import('./proxy-helper.js')
    return applyProxyFallback()
  })
  // Profile 级代理测试：测试指定 Profile 的代理连通性
  ipcMain.handle(IPC_CHANNELS.APP_TEST_PROFILE_PROXY, async (_e, profileId: string) => {
    const { testProfileProxyConnectivity } = await import('./proxy-helper.js')
    return testProfileProxyConnectivity(profileId)
  })
  // Profile 级代理即时生效：将 Profile.proxyConfig 应用到其 session
  ipcMain.handle(IPC_CHANNELS.APP_APPLY_PROFILE_PROXY, async (_e, profileId: string) => {
    const { applyProfileProxy } = await import('./proxy-helper.js')
    await applyProfileProxy(profileId)
  })
  // Profile 级代理失败兜底：浏览器窗口 webview 加载失败时触发
  ipcMain.handle(IPC_CHANNELS.APP_PROFILE_PROXY_FALLBACK, async (_e, profileId: string) => {
    const { applyProxyFallback } = await import('./proxy-helper.js')
    return applyProxyFallback(profileId)
  })

  // 数据迁移：选择导出文件保存路径（弹出系统保存对话框）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_EXPORT_PATH, async () => {
    const result = await dialog.showSaveDialog({
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      defaultPath: `sidekickai-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    })
    return result.canceled ? null : result.filePath
  })

  // 数据迁移：选择导入文件（弹出系统打开对话框）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_IMPORT_FILE, async () => {
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 数据迁移：导出所有数据到指定路径（细粒度控制）
  ipcMain.handle(IPC_CHANNELS.APP_EXPORT_DATA, async (_e, targetPath: string, options: {
    basicData: boolean;
    cookies: boolean;
    indexedDB: boolean;
    cache: boolean;
    voiceAssets: boolean;
  }) => {
    const { exportAllData } = await import('./backup-restore.js')
    return exportAllData(targetPath, options)
  })

  // 数据迁移：从 zip 文件导入所有数据（导入后应用自动重启）
  ipcMain.handle(IPC_CHANNELS.APP_IMPORT_DATA, async (_e, zipPath: string) => {
    const { importAllData } = await import('./backup-restore.js')
    return importAllData(zipPath)
  })

  // 数据迁移：估算各类别导出体积（字节）
  ipcMain.handle(IPC_CHANNELS.APP_ESTIMATE_EXPORT_SIZES, async () => {
    const { estimateExportSizes } = await import('./backup-restore.js')
    return estimateExportSizes()
  })

  // 数据迁移：打开数据导出独立窗口（单例）
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_EXPORT_WINDOW, async () => {
    const { showDataExportWindow } = await import('../window-factory/popup-windows.js')
    showDataExportWindow()
  })

  // 缓存清理：清理缓存数据（仅缓存类目录与 session cache，保留登录态）
  ipcMain.handle(IPC_CHANNELS.APP_CLEAN_CACHE, async () => {
    const { cleanCacheData } = await import('./backup-restore.js')
    const result = await cleanCacheData()
    // 更新上次清理时间戳
    updateAppSettings({ lastCacheCleanAt: Date.now() })
    return result
  })

  // 缓存清理：估算当前缓存体积
  ipcMain.handle(IPC_CHANNELS.APP_ESTIMATE_CACHE_SIZE, async () => {
    const { estimateCacheSize } = await import('./backup-restore.js')
    return estimateCacheSize()
  })

  // 下载：选择下载目录（弹出系统目录选择对话框）
  ipcMain.handle(IPC_CHANNELS.APP_SELECT_DOWNLOAD_DIR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 下载：在系统文件管理器中打开下载目录（无配置时打开系统下载目录）
  ipcMain.handle(IPC_CHANNELS.APP_OPEN_DOWNLOAD_DIR, async () => {
    const settings = getAppSettings()
    const dir = settings.downloadDir || app.getPath('downloads')
    try {
      await shell.openPath(dir)
    } catch (err) {
      console.error('[app-settings] 打开下载目录失败:', err)
    }
  })

  // 文件拖拽导入：读取文件并以 data URL 形式返回（用于跨 webview 边界传递文件内容）
  ipcMain.handle(IPC_CHANNELS.WEBVIEW_FILE_DROP, async (_e, filePaths: string[]) => {
    const { readFilesAsDataUrls } = await import('../utils/file-drop-handler.js')
    return readFilesAsDataUrls(filePaths)
  })

  // ===== 每应用浏览器窗口脱离/回归快捷键 =====
  // 保存/清除指定 Profile 的浏览器窗口快捷键，并重注册全局快捷键
  ipcMain.handle(
    IPC_CHANNELS.PROFILE_SHORTCUT_SET,
    async (_e, { profileId, accelerator }: { profileId: string; accelerator: string | null }) => {
      const { profileStore } = await import('./profile-store.js')
      const updated = await profileStore.update(profileId, {
        browserWindowShortcut: accelerator || undefined,
      })
      await reregisterProfileShortcuts()
      return updated
    },
  )
}

/**
 * 重新注册所有 Profile 的浏览器窗口脱离/回归快捷键。
 *
 * 遍历所有 Profile，注册非空 browserWindowShortcut（accelerator 字符串）到系统 globalShortcut。
 * 触发时调用 toggleBrowserWindow(profileId) 脱离/回归对应应用的浏览器窗口
 * （已打开则回归关闭、未打开则脱离主窗口标签迁出）。
 *
 * 设计要点：
 * - 按 accelerator 去重避免同一组合键被多次注册（先到先得）
 * - 默认无快捷键（Profile.browserWindowShortcut 为 undefined 时不注册）
 * - 全部为系统级全局快捷键（应用未聚焦也生效）
 */
export async function reregisterProfileShortcuts(): Promise<void> {
  const mgr = getHotkeyManagerInstance()
  if (!mgr) return

  // 1. 注销所有旧的浏览器全局快捷键
  mgr.unregisterAllBrowserShortcuts()

  // 2. 收集所有 Profile 的快捷键（按 accelerator 去重，先到先得）
  const seen = new Set<string>()
  const toRegister: Array<{ accelerator: string; profileId: string }> = []

  try {
    const { profileStore } = await import('./profile-store.js')
    for (const profile of profileStore.list()) {
      const acc = profile.browserWindowShortcut
      if (!acc) continue
      if (seen.has(acc)) {
        console.warn(`[reregisterProfileShortcuts] 快捷键 ${acc} 已被其他应用占用，跳过 Profile ${profile.id}（${profile.name}）`)
        continue
      }
      seen.add(acc)
      toRegister.push({ accelerator: acc, profileId: profile.id })
    }
  } catch (err) {
    console.warn('[reregisterProfileShortcuts] 读取 profileStore 失败:', err)
    return
  }

  // 3. 注册新的全局快捷键
  for (const { accelerator, profileId } of toRegister) {
    mgr.registerBrowserShortcut(accelerator, () => {
      // ESM 环境中 require 未定义,使用动态 import() 避免闪退
      import('../window-factory.js').then(({ toggleBrowserWindow }) => {
        toggleBrowserWindow(profileId)
      }).catch((e) => {
        console.error('[reregisterProfileShortcuts] 动态导入失败:', e)
      })
    })
  }
}

/**
 * 应用开机自启动设置到系统。
 * 调用 Electron app.setLoginItemSettings，根据 silentStart 决定是否注入 --hidden 参数。
 * - silentStart=true：启动时带 --hidden，隐藏到托盘
 * - silentStart=false：启动时正常显示主窗口
 * @returns 是否设置成功（失败时返回 false 但不抛异常）
 */
export function applyAutoLaunchSetting(enabled: boolean, silentStart: boolean): boolean {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: silentStart ? ['--hidden'] : [],
    })
    console.log(
      `[app-settings] 自启动设置已${enabled ? '开启' : '关闭'}${silentStart ? '（静默启动）' : ''}`,
    )
    return true
  } catch (e) {
    console.error('[app-settings] 设置自启动失败:', (e as Error).message)
    return false
  }
}
