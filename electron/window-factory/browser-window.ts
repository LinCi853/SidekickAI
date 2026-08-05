// electron/window-factory/browser-window.ts — 多标签浏览器窗口创建
//
// v0.0.9：从独立窗口升级为 Chrome 风格多标签浏览器窗口。
// 与 createStandaloneWindow 的区别：
//   - 默认最大化，还原尺寸 1280×800
//   - minWidth 800 / minHeight 600
//   - 使用独立 session（persist:${profileId}-browser）
//   - 加载 mode='browser' 渲染进程

import { BrowserWindow, screen, session, type DownloadItem } from 'electron'
import { browserWindowStore } from '../store/browser-window-store.js'
import { profileStore } from '../store/profile-store.js'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { randomUUID } from 'crypto'
import path from 'path'
import { app } from 'electron'
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

    // 通知渲染层下载开始
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, {
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state: 'progressing',
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        startTime: Date.now(),
      })
    }

    // 监听下载进度
    item.on('updated', (_e2, state) => {
      if (win.isDestroyed()) return
      if (state === 'progressing') {
        win.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, {
          id: downloadId,
          windowId,
          profileId,
          url: item.getURL(),
          filename,
          savePath,
          state: 'progressing',
          totalBytes: item.getTotalBytes(),
          receivedBytes: item.getReceivedBytes(),
          startTime: Date.now(),
        })
      }
    })

    // 监听下载完成
    item.once('done', (_e2, state) => {
      if (win.isDestroyed()) return
      win.webContents.send(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, {
        id: downloadId,
        windowId,
        profileId,
        url: item.getURL(),
        filename,
        savePath,
        state,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        startTime: Date.now(),
        endTime: Date.now(),
      })
    })
  })
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
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: true,
    }),
  }))

  attachWebviewAntiDetection(win.webContents)
  attachWebviewPopupInterceptor(win.webContents)

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

  setupBoundsTracking(win, windowId)

  windowState.detachedWindows.set(windowId, win)

  // v0.0.9: 窗口关闭时保底触发 MIGRATE_BACK（beforeunload 可能不可靠）
  // 从 browserWindowStore 读取最终标签状态，发送给主窗口
  win.on('closed', () => {
    const savedState = browserWindowStore.get(windowId)
    if (!savedState) return
    const mainWindow = windowState.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    // 收集所有网页标签的 finalUrls
    const finalUrls = savedState.tabs
      .filter((t) => t.source !== 'settings' && t.source !== 'bookmark-manager')
      .map((t) => ({
        tabId: t.parentTabId || t.id,
        url: t.url || '',
        title: t.title || '',
      }))

    const activeTab = savedState.tabs.find((t) => t.id === savedState.activeTabId)
    const activeUrl = (activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager')
      ? (activeTab.url || '')
      : (finalUrls[0]?.url ?? '')
    const activeTitle = (activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager')
      ? (activeTab.title || '')
      : (finalUrls[0]?.title ?? '')

    mainWindow.webContents.send(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, {
      profileId: savedState.profileId,
      url: activeUrl,
      title: activeTitle,
      finalUrls,
    })

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

  // 保留生命周期管理（bounds 持久化等），但不再重复 delete（closed handler 已做）
  attachDetachedWindowLifecycle(win, windowId, () => {})

  return win
}
