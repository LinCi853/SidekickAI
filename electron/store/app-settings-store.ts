// electron/store/app-settings-store.ts — 应用全局设置持久化存储 + IPC 注册
//
// 使用 electron-store 将应用设置持久化到磁盘（app-settings.json）。
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
import { createJsonStore, isPortableMode } from './store-paths.js'

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
  /** 需求 7：Cookie 弹窗白名单（自动点击"接受全部"），默认含 google.com / openai.com */
  cookieWhitelist: string[]
  /** 需求 7：Cookie 弹窗黑名单（直接隐藏所有 cookie 弹窗） */
  cookieBlacklist: string[]
  /** 需求 7：同域名重复弹窗冷却时间（ms），默认 60000（60 秒） */
  cookiePopupCooldownMs: number
  /** 需求 7：Cookie 弹窗自动处理总开关（默认 true） */
  cookieHandlerEnabled: boolean
  /** v0.5.2 R-3：AI 应用独立窗口默认打开的 tab（Alt+Q 入口） */
  defaultAiAppTab: 'chat' | 'whiteboard' | 'notes'
}

const store = createJsonStore<{ settings: AppSettings; version: number }>({
  name: 'app-settings',
  defaults: {
    settings: {
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
      popupWhitelist: [],
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
      // v0.5.2 R-3：AI 应用独立窗口默认打开的 tab
      defaultAiAppTab: 'chat',
    },
    version: 1,
  },
})

/** 读取应用设置 */
export function getAppSettings(): AppSettings {
  const s = { ...store.get('settings') }
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
  // 兼容旧版本设置文件：popupWhitelist 字段可能不存在
  s.popupWhitelist = s.popupWhitelist ?? []
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
  s.defaultAiAppTab = s.defaultAiAppTab ?? 'chat'
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
  const dataDir = isPortableMode()
    ? path.join(path.dirname(app.getPath('exe')), 'data')
    : app.getPath('userData')

  console.log('[app-settings] 开始清理所有用户数据:', dataDir)

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

  // 3. 关闭 SQLite 连接（释放 WAL 旁路文件锁，避免 fs.rmSync 失败）
  try {
    const { closeChatStore } = await import('./chat-store.js')
    closeChatStore()
  } catch (err) {
    console.warn('[app-settings] 关闭 SQLite 失败:', err)
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
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log('[app-settings] 已清除所有用户数据:', dataDir)
  } catch (err) {
    console.error('[app-settings] 递归删除失败，尝试逐个删除关键子项:', err)
    // Windows 上 GPUCache/Crashpad/SingletonLock/Partitions 等可能因句柄未完全释放而失败
    // 逐个尝试删除关键子目录和文件，最大程度清理
    const subPaths = [
      'GPUCache',
      'Crashpad',
      'Session Storage',
      'Local Storage',
      'IndexedDB',
      'Service Worker',
      'Cache',
      'Code Cache',
      'Cookies',
      'Cookies-journal',
      'Network',
      'Partitions',
      'bin',
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      'app-settings.json',
      'window-states.json',
      'ai-providers.json',
      'profiles.json',
      'voice-config.json',
      'hotkey.json',
      'prompts.json',
      'presets.json',
      'block-rules.json',
      'chat.db',
      'chat.db-wal',
      'chat.db-shm',
    ]
    for (const sub of subPaths) {
      try {
        fs.rmSync(path.join(dataDir, sub), { recursive: true, force: true })
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
  const current = store.get('settings')
  const next: AppSettings = { ...current, ...patch }
  // 关闭 autoLaunch 时自动重置 silentStart=false（保持字段语义一致，避免 autoLaunch=false 但 silentStart=true 的非法态）
  if (patch.autoLaunch === false) {
    next.silentStart = false
  }
  store.set('settings', next)
  // autoLaunch 或 silentStart 变化时立即同步系统注册项（避免必须重启应用才生效）
  if (patch.autoLaunch !== undefined || patch.silentStart !== undefined) {
    const ok = applyAutoLaunchSetting(next.autoLaunch, next.silentStart)
    if (!ok) {
      // 系统注册失败：回滚 store 字段并抛错，让渲染层 catch 后回滚本地 UI 状态
      store.set('settings', current)
      throw new Error('应用开机自启动设置失败（系统层拒绝）')
    }
  }
  // UI 比例变化时广播到所有窗口，渲染层据此重新计算最小尺寸并调用 setMinimumSize
  if (patch.uiScale && patch.uiScale !== current.uiScale) {
    broadcastUiScaleChanged(next.uiScale)
  }
  return next
}

/**
 * 向所有 BrowserWindow 广播 UI 比例变化。
 * 各窗口渲染层收到后，根据自身窗口类型重新计算最小宽度并调用 setMinimumSize。
 */
function broadcastUiScaleChanged(uiScale: 'small' | 'medium' | 'large'): void {
  broadcastToAllWindows(IPC_CHANNELS.UI_SCALE_CHANGED, uiScale, 'app-settings')
}

/** 注册应用设置 IPC 处理器（含代理测试与即时生效） */
export function registerAppSettingsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.APP_GET_SETTINGS, () => getAppSettings())
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

  // 弹窗白名单：渲染层请求将 origin 加入白名单（持久化到 AppSettings.popupWhitelist）
  ipcMain.handle(IPC_CHANNELS.POPUP_WHITELIST_ADD, (_e, origin: string) => {
    const current = getAppSettings()
    const whitelist = current.popupWhitelist ?? []
    if (!whitelist.includes(origin)) {
      const next = [...whitelist, origin]
      updateAppSettings({ popupWhitelist: next })
      console.log('[app-settings] 已加入弹窗白名单:', origin)
    }
    return getAppSettings().popupWhitelist ?? []
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
