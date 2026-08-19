// electron/window-factory/browser-window.ts — 多标签浏览器窗口创建
//
// v0.0.9：Chrome 风格多标签浏览器窗口。
//   - 默认最大化，还原尺寸 1280×800
//   - minWidth 800 / minHeight 600
//   - 使用独立 session（persist:${profileId}-browser）
//   - 加载 mode='browser' 渲染进程

import { BrowserWindow, ipcMain, nativeImage, screen, session, dialog, type DownloadItem } from 'electron'
import { browserWindowStore } from '../store/browser-window-store.js'
import { profileStore } from '../store/profile-store.js'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { isModuleEnabled } from '../modules/registry.js'
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
import { isFrozen } from '../freeze/freeze-manager.js'
import { getRecordByTabId } from '../freeze/webview-registry.js'
import { consumeAskSavePath } from '../utils/ask-save-path.js'
import { isCloudPc, exitCloudPc } from '../utils/cloud-pc.js'
import { buildWindowConfig } from './window-config-builder.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
import { detachProfileToBrowserWindow } from './detach-profile.js'
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
      // pointerLock / keyboardLock：云游戏与网页游戏必需的鼠标捕获/键盘捕获权限
      const allowed = new Set(['media', 'geolocation', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection'])
      callback(allowed.has(permission))
    })
  }

  ses.on('will-download', (_e, item: DownloadItem) => {
    // 统一计算最终保存路径：
    // - 「另存为」下载（右键链接/图片另存为）：弹保存对话框选择路径，取消则终止下载
    // - 普通下载：静默保存到用户配置的下载目录
    let filename: string
    let savePath: string
    const isAskSavePath = consumeAskSavePath()
    if (isAskSavePath) {
      const askFilename = (item.getFilename() || 'download').replace(/[\\/:*?"<>|]/g, '_')
      // 使用注册下载处理时闭包的浏览器窗口作为对话框父窗口
      const result = dialog.showSaveDialogSync(win, {
        title: '另存为',
        defaultPath: askFilename,
        filters: [{ name: '所有文件', extensions: ['*'] }],
      })
      if (!result) {
        item.cancel()
        return
      }
      filename = item.getFilename() || 'download'
      savePath = result
    } else {
      const settings = getAppSettings()
      const dir = settings.downloadDir || app.getPath('downloads')
      filename = item.getFilename() || 'download'
      savePath = path.join(dir, filename)
    }
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

/** app 是否正在退出（云电脑模式 close 保护的放行条件） */
let appQuitting = false
try {
  app.on('before-quit', () => { appQuitting = true })
} catch { /* ignore */ }

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
  // 模块门控（11.10）：浏览器模块关闭时不创建浏览器窗口
  if (!isModuleEnabled('browser')) {
    throw new Error('[browser-window] 浏览器模块未启用，拒绝创建浏览器窗口')
  }
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
    title: `工百窗 - ${profile?.name || '浏览器'}`,
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
    // 云电脑模式：Ctrl+W 等全部放行给远端（退出兜底在 helpers.ts 的 guest 拦截中处理）
    if (isCloudPc(win.webContents.id)) return
    const mods = input.modifiers || []
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const hasAlt = mods.includes('alt')
    const hasShift = mods.includes('shift')

    // F11：切换沉浸式全屏（宿主 UI 聚焦时主进程直接兜底，
    // 不依赖渲染层 defs；webview 聚焦时由 helpers.ts 的 guest 拦截处理）
    if (input.key === 'F11' && !hasCtrl && !hasAlt && !hasShift) {
      event.preventDefault()
      console.log('[browser-window] F11 → 宿主兜底切换沉浸式全屏')
      try { win.setFullScreen(!win.isFullScreen()) } catch (err) {
        console.error('[browser-window] 切换全屏失败:', err)
      }
      return
    }

    // Escape：全屏时退出（沉浸式全屏的标准退出方式，宿主兜底）
    if (input.key === 'Escape' && !hasCtrl && !hasAlt && !hasShift) {
      if (win.isFullScreen()) {
        event.preventDefault()
        console.log('[browser-window] Escape → 宿主兜底退出全屏')
        try { win.setFullScreen(false) } catch { /* ignore */ }
        return
      }
    }
    const hasMeta = mods.includes('meta') || mods.includes('command')
    if (!hasCtrl && !hasShift && !hasAlt && !hasMeta && input.key === 'F12') {
      const state = browserWindowStore.get(windowId)
      const tabId = state?.activeTabId ?? null
      if (tabId && getRecordByTabId(tabId) && isFrozen(tabId)) {
        event.preventDefault()
        console.log('[hotkey] F12 跳过：当前浏览器标签处于冻结态')
        return
      }
    }
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
  // 云电脑模式：阻止窗口关闭（Alt+F4 已路由到远端；退出需先退出云电脑模式）。
  // app 退出（before-quit）时放行，避免应用无法退出。
  win.on('close', (event) => {
    if (isCloudPc(win.webContents.id) && !appQuitting) {
      event.preventDefault()
      console.log('[cloud-pc] 窗口关闭被拦截（Alt+F4 已路由到云电脑远端）')
    }
  })

  win.on('closed', () => {
    // 云电脑模式清理：窗口关闭时恢复挂起的全局热键（防止泄漏）
    try { exitCloudPc(win.webContents.id) } catch { /* ignore */ }
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
      const internalSources = ['settings', 'bookmark-manager', 'history', 'downloads', 'view-source', 'print-preview']
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
 * 切换指定 Profile 的浏览器窗口（窗口快捷键触发）：脱离 / 回归。
 *
 * - 浏览器窗口已打开 → 回归：关闭浏览器窗口，标签自动回迁主窗口
 *   （closed 事件检测到 parentTabId 后触发 BROWSER_TAB_MIGRATE_BACK）
 * - 浏览器窗口未打开 → 脱离：将主窗口中该 Profile 的标签迁出为独立浏览器窗口
 *   - 主窗口有该 Profile 标签 → 直接脱离（复用 DETACH_TAB 逻辑，带 parentTabId）
 *   - 主窗口无该 Profile 标签 → 先在主窗口创建标签，再脱离（保证快捷键始终有效）
 *
 * 与「打开/关闭」不同：脱离/回归保留主窗口标签与浏览器窗口的归属关系，
 * 回归时标签回到主窗口原位并恢复最后浏览的 URL。
 *
 * @param profileId 目标 Profile id
 */
export async function toggleBrowserWindow(profileId: string): Promise<void> {
  // 模块门控（11.10）：浏览器模块关闭时快捷键已注销，此处兜底拒绝
  if (!isModuleEnabled('browser')) {
    console.warn('[browser-window] 浏览器模块未启用，拒绝脱离/回归')
    return
  }
  // 串行化锁：同 Profile 的快捷键若上一次尚未完成（含兜底等待渲染层创建标签），
  // 直接忽略本次，避免连续触发开出多个窗口。
  if (toggleInFlight.has(profileId)) return
  toggleInFlight.add(profileId)
  try {
    await toggleBrowserWindowInner(profileId)
  } finally {
    toggleInFlight.delete(profileId)
  }
}

/** 正在执行 toggleBrowserWindow 的 Profile id 集合（防并发重复触发） */
const toggleInFlight = new Set<string>()

async function toggleBrowserWindowInner(profileId: string): Promise<void> {
  // 回归分支：浏览器窗口已打开 → 关闭（closed 事件自动回迁标签）
  const existing = windowState.browserWindowsByProfile.get(profileId)
  if (existing && !existing.isDestroyed()) {
    existing.close()
    return
  }

  // 脱离分支：浏览器窗口未打开 → 将主窗口该 Profile 标签迁出
  const mainState = windowStore.getOrDefault(MAIN_WINDOW_ID)
  const existingTab = mainState.tabs.find((t) => t.profileId === profileId)

  if (existingTab) {
    // 主窗口已有该 Profile 标签 → 直接脱离（带 parentTabId，回归时可回迁）
    await detachProfileToBrowserWindow(MAIN_WINDOW_ID, existingTab.id, { createBrowserWindow })
    return
  }

  // 兜底：主窗口无该 Profile 标签 → 请求主窗口渲染层创建标签（渲染层为标签真源，
  // 创建后 persist 保证数据一致），收到 tabId 后再脱离
  const mainWindow = windowState.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn(`[toggleBrowserWindow] 主窗口不可用，无法兜底创建标签`)
    return
  }

  const tabId = await new Promise<string | null>((resolve) => {
    let settled = false
    const onResult = (_e: unknown, payload: { profileId: string; tabId: string | null }) => {
      if (payload.profileId !== profileId || settled) return
      settled = true
      ipcMain.off(IPC_CHANNELS.TAB_ENSURE_AND_DETACH_RESULT, onResult)
      resolve(payload.tabId)
    }
    ipcMain.on(IPC_CHANNELS.TAB_ENSURE_AND_DETACH_RESULT, onResult)
    mainWindow.webContents.send(IPC_CHANNELS.TAB_ENSURE_AND_DETACH, profileId)
    // 超时兜底：3 秒内无回复则放弃（避免泄漏 listener）
    setTimeout(() => {
      if (settled) return
      settled = true
      ipcMain.off(IPC_CHANNELS.TAB_ENSURE_AND_DETACH_RESULT, onResult)
      console.warn(`[toggleBrowserWindow] 兜底创建标签超时`)
      resolve(null)
    }, 3000)
  })

  if (!tabId) return
  await detachProfileToBrowserWindow(MAIN_WINDOW_ID, tabId, { createBrowserWindow })
}

