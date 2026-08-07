// electron/window-factory/browser-window.ts — 多标签浏览器窗口创建
//
// v0.0.9：从独立窗口升级为 Chrome 风格多标签浏览器窗口。
// 与 createStandaloneWindow 的区别：
//   - 默认最大化，还原尺寸 1280×800
//   - minWidth 800 / minHeight 600
//   - 使用独立 session（persist:${profileId}-browser）
//   - 加载 mode='browser' 渲染进程

import { BrowserWindow, nativeImage, screen, session, type DownloadItem } from 'electron'
import { browserWindowStore } from '../store/browser-window-store.js'
import { profileStore } from '../store/profile-store.js'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { randomUUID } from 'crypto'
import path from 'path'
import { app } from 'electron'
import { browserDownloadStore } from '../store/browser-download-store.js'
import {
  WINDOW_BACKGROUND_COLOR,
  getPreloadPath,
  attachWebviewPopupInterceptor,
  attachWebviewAntiDetection,
  loadRenderer,
  createDefaultWebPreferences,
  attachDetachedWindowLifecycle,
  safeLogWindowTrace,
  setupBoundsTracking,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
import type { BrowserTabState, BrowserWindowState } from '../shared/browser.types.js'

/** 广播下载状态更新给所有窗口（含浏览器窗口和历史下载管理窗口） */
function broadcastDownloadUpdated(payload: {
  id: string
  windowId: string
  profileId: string
  url: string
  filename: string
  savePath: string
  state: string
  totalBytes: number
  receivedBytes: number
  startTime: number
  endTime?: number
}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, payload)
      } catch { /* ignore */ }
    }
  }
}

/**
 * 为浏览器窗口的 session 注册下载处理。
 * v0.0.9：partition 统一为 persist:${profileId}（与 BrowserWebviewTab 对齐，修复下载不捕获 bug）
 * 下载文件保存到用户配置的下载目录，并通过 IPC 通知渲染层。
 */
function registerBrowserDownloads(win: BrowserWindow, windowId: string, profileId: string): void {
  // 修复：原来用 persist:${profileId}-browser，但 webview 用 persist:${profileId}，
  // 导致 webview 下载无法被捕获。统一为 persist:${profileId}。
  const partition = `persist:${profileId}`
  const ses = session.fromPartition(partition)

  // 避免重复挂载
  if ((ses as unknown as { __browserDownloadAttached?: boolean }).__browserDownloadAttached) return
  ;(ses as unknown as { __browserDownloadAttached?: boolean }).__browserDownloadAttached = true

  // v0.0.9：挂载权限处理器（通知/下载等按 sitePermissions 过滤）
  if (!(ses as unknown as { __permissionHandlerAttached?: boolean }).__permissionHandlerAttached) {
    ;(ses as unknown as { __permissionHandlerAttached?: boolean }).__permissionHandlerAttached = true
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      // 默认放行常见权限；下载权限由 will-download + sitePermissions.blockDownload 控制
      // 通知权限可被 sitePermissions.blockNotification 拦截（由渲染层在 setPermissionRequestHandler 时按 tab 过滤）
      const allowed = new Set(['media', 'geolocation', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'])
      callback(allowed.has(permission))
    })
  }

  ses.on('will-download', (_e, item: DownloadItem) => {
    const settings = getAppSettings()
    const dir = settings.downloadDir || app.getPath('downloads')
    const filename = item.getFilename() || 'download'
    const savePath = path.join(dir, filename)
    item.setSavePath(savePath)

    const downloadId = randomUUID()
    const startTime = Date.now()

    // 写入下载记录到存储
    try {
      browserDownloadStore.add({
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state: 'progressing',
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        startTime,
      })
    } catch (err) {
      console.error('[browser-window] 写入下载记录失败:', err)
    }

    // 广播下载开始事件给所有窗口（含历史下载管理窗口）
    broadcastDownloadUpdated({
      id: downloadId,
      windowId,
      profileId,
      url: item.getURL(),
      filename,
      savePath,
      state: 'progressing',
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      startTime,
    })

    // 监听下载进度
    item.on('updated', (_e2, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        // 更新存储
        try {
          browserDownloadStore.update(downloadId, { receivedBytes: received, totalBytes: total, state: 'progressing' })
        } catch { /* ignore */ }
        // 广播
        broadcastDownloadUpdated({
          id: downloadId,
          windowId,
          profileId,
          url: item.getURL(),
          filename,
          savePath,
          state: 'progressing',
          totalBytes: total,
          receivedBytes: received,
          startTime,
        })
      }
    })

    // 监听下载完成
    item.once('done', (_e2, state) => {
      const endTime = Date.now()
      const finalState = state === 'completed' ? 'completed' : state === 'interrupted' ? 'interrupted' : 'cancelled'
      // 更新存储
      try {
        browserDownloadStore.update(downloadId, {
          state: finalState,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          endTime,
        })
      } catch { /* ignore */ }
      // 广播
      broadcastDownloadUpdated({
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state: finalState,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        startTime,
        endTime,
      })
    })
  })
}

/**
 * 为浏览器窗口生成 Profile 专属图标（首字母 + 主题色）。
 * 使用 SVG data URL + nativeImage.createFromDataURL，避免依赖额外图像库。
 */
function generateProfileIcon(name: string, color: string): Electron.NativeImage | null {
  try {
    const letter = (name || '?').charAt(0).toUpperCase()
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${color}"/><text x="32" y="32" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="central">${letter}</text></svg>`
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    const img = nativeImage.createFromDataURL(dataUrl)
    return img.isEmpty() ? null : img
  } catch (err) {
    console.error('[browser-window] 生成 icon 失败:', err)
    return null
  }
}

/**
 * 创建多标签浏览器窗口。
 *
 * @param windowId 浏览器窗口 id（UUID）
 * @param profileId 绑定的 Profile id
 */
export function createBrowserWindow(windowId: string, profileId: string): BrowserWindow {
  const saved = browserWindowStore.get(windowId)
  const profile = profileStore.get(profileId)
  const workArea = screen.getPrimaryDisplay().workArea
  const isMaximized = saved?.isMaximized ?? true

  // E3：根据 Profile 设置窗口标题与图标（首字母 + 主题色），覆盖默认 DeepSeek 窗口外观
  // 主题色优先级：profile.aiThemeColor > 平台默认 themeColor > '#c25a4a'
  const themeColor =
    profile?.aiThemeColor ||
    AI_PLATFORMS.find((p) => p.id === profile?.aiPlatformId)?.themeColor ||
    '#c25a4a'
  const profileIcon = profile ? generateProfileIcon(profile.name, themeColor) : null

  const win = new BrowserWindow(buildWindowConfig({
    width: isMaximized ? workArea.width : (saved?.bounds.width || 1280),
    height: isMaximized ? workArea.height : (saved?.bounds.height || 800),
    x: isMaximized ? workArea.x : (saved?.bounds.x),
    y: isMaximized ? workArea.y : (saved?.bounds.y),
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: saved?.alwaysOnTop ?? false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: profile?.name || 'SidekickAI',
    icon: profileIcon || undefined,
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: true,
    }),
  }))

  attachWebviewAntiDetection(win.webContents)
  attachWebviewPopupInterceptor(win.webContents)

  // v0.0.9 B4：主 webContents 兜底拦截 Ctrl+W，确保浏览器窗口任意位置（标签栏、地址栏、
  // 页面容器等非 webview 焦点区域）都能关闭当前标签。
  // webview 焦点时由 helpers.ts 的 guest webContents before-input-event 处理；
  // 此处仅作用于主 webContents，不与 webview 拦截冲突。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mods = input.modifiers || []
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const hasShift = mods.includes('shift')
    const hasAlt = mods.includes('alt')
    const hasMeta = mods.includes('meta') || mods.includes('command')
    // Ctrl+W：关闭当前标签（排除 Shift/Alt/Meta，避免误触）
    if (hasCtrl && !hasShift && !hasAlt && !hasMeta && input.key.toLowerCase() === 'w') {
      event.preventDefault()
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'closeTab' })
      }
    }
  })

  if (isMaximized) {
    win.maximize()
  }

  loadRenderer(win, windowId, 'browser', { profileId })

  // 注册下载处理
  registerBrowserDownloads(win, windowId, profileId)

  win.once('ready-to-show', () => {
    win.show()
    safeLogWindowTrace(windowId, 'create')
  })

  // 浏览器窗口：不保存 bounds，取消最大化时由 WindowMaximizeManager 使用
  // centered70 策略还原为工作区居中 70% 尺寸（固定设计，不记忆位置/大小）
  attachDetachedWindowLifecycle(win, windowId, () => {}, { trackBounds: false })
  win.on('leave-full-screen', () => {
    const state = windowStore.getOrDefault(windowId)
    if (state.fullscreenNormalBounds && !win.isDestroyed()) {
      try {
        win.setBounds(state.fullscreenNormalBounds)
      } catch {
        // 忽略：窗口可能正在切换中
      }
      state.fullscreenNormalBounds = undefined
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, false)
    }
  })
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, true)
    }
  })

  windowState.detachedWindows.set(windowId, win)
  // 注册 profileId -> win 映射（快捷键切换用）；若同一 profile 已有旧窗口，先清理引用
  windowState.browserWindowsByProfile.set(profileId, win)

  // v0.0.9: 窗口关闭时保底触发 MIGRATE_BACK（beforeunload 可能不可靠）
  // 从 browserWindowStore 读取最终标签状态，发送给主窗口
  win.on('closed', () => {
    // 清理 profileId -> win 映射（仅当当前映射指向此 win 时才删除，避免误删新窗口引用）
    const mapped = windowState.browserWindowsByProfile.get(profileId)
    if (mapped === win) {
      windowState.browserWindowsByProfile.delete(profileId)
    }
    const savedState = browserWindowStore.get(windowId)
    if (!savedState) return
    const mainWindow = windowState.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    // P0-4：一个 AI 应用 = 一个主标签。浏览器窗口关闭时仅恢复主标签（最后浏览的非内部页），
    // 不再将所有标签迁移回主窗口。浏览器窗口内的浏览历史通过 navHistoryStore 独立保存。
    const hasParentTab = savedState.tabs.some((t) => t.parentTabId)
    if (hasParentTab) {
      // 取当前激活的非内部标签 URL/title（内部页 settings/bookmark/history/downloads 跳过）
      const internalSources = ['settings', 'bookmark-manager', 'history', 'downloads']
      const activeTab = savedState.tabs.find((t) => t.id === savedState.activeTabId)
      const activeNonInternal = activeTab && !internalSources.includes(activeTab.source)
        ? activeTab
        : savedState.tabs.find((t) => !internalSources.includes(t.source))

      mainWindow.webContents.send(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, {
        profileId: savedState.profileId,
        url: activeNonInternal?.url || '',
        title: activeNonInternal?.title || '',
      })
    }

    // 将主窗口带到前台
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()

    // v0.0.9: 清理主窗口持久化状态（detachedProfiles + detachedWindowId）
    const mainState = windowStore.get(MAIN_WINDOW_ID)
    if (mainState) {
      const detachedProfiles = (mainState.detachedProfiles ?? []).filter((id) => id !== savedState.profileId)
      const restoredTabs = mainState.tabs.map((t) =>
        t.profileId === savedState.profileId
          ? { ...t, detachedWindowId: null }
          : t,
      )
      windowStore.save(MAIN_WINDOW_ID, { ...mainState, tabs: restoredTabs, detachedProfiles })
    }

    // 清理浏览器窗口状态
    browserWindowStore.delete(windowId)
  })

  return win
}

/**
 * 切换指定 Profile 的浏览器窗口显隐（快捷键触发）。
 *
 * 行为类比 Alt+Q 切换进阶面板：
 * - 浏览器窗口已打开 → 关闭它（win.close()）
 * - 浏览器窗口未打开 → 创建新的浏览器窗口，初始标签为该 Profile 的 AI 平台 URL
 *
 * 独立打开的窗口（非从主窗口脱离）关闭时不回迁标签到主窗口（closed 事件检查 parentTabId）。
 *
 * @param profileId 目标 Profile id
 */
export function toggleBrowserWindow(profileId: string): void {
  const existing = windowState.browserWindowsByProfile.get(profileId)
  if (existing && !existing.isDestroyed()) {
    // 已打开 → 关闭
    existing.close()
    return
  }

  // 未打开 → 创建新的浏览器窗口
  const profile = profileStore.get(profileId)
  if (!profile) {
    console.warn(`[toggleBrowserWindow] Profile ${profileId} 不存在`)
    return
  }

  const windowId = randomUUID()
  const tabId = randomUUID()
  const initialUrl = profile.aiPlatformUrl || ''

  const tab: BrowserTabState = {
    id: tabId,
    profileId,
    title: profile.name || '',
    url: initialUrl,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    order: 0,
    source: 'initial',
    kind: 'home',
    // 独立打开：不设 parentTabId，closed 时不回迁主窗口
  }

  const state: BrowserWindowState = {
    windowId,
    profileId,
    bounds: { width: 0, height: 0 },
    isMaximized: true,
    isFullscreen: false,
    alwaysOnTop: false,
    activeTabId: tabId,
    tabs: [tab],
    aiPlatformId: profile.aiPlatformId,
    platformName: profile.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)?.name
      : undefined,
  }
  browserWindowStore.save(windowId, state)
  createBrowserWindow(windowId, profileId)
}
