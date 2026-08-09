// electron/ipc/tab-ipc.ts — 标签相关 IPC 注册
//
// 包含：
//   - 标签 CRUD（TAB_UPDATE_TITLE / TAB_UPDATE_URL / TAB_UPDATE_HOME_URL）
//   - 标签脱离（WIN_CONTROL_DETACH_TAB）：
//     隐藏语义——主窗口隐藏该 Profile 的全部标签（标记 detachedProfiles），
//     浏览器窗口使用同一个 session partition（persist:${profileId}），
//     保留全部登录态和页面数据。浏览器窗口关闭时恢复主窗口标签。
//
// 在 app.whenReady 后由 main.ts 调用 registerTabIpc(deps) 完成注册。

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { windowStore } from '../store/window-store.js'
import { browserWindowStore } from '../store/browser-window-store.js'
import { navHistoryStore } from '../store/nav-history-store.js'
import { windowState } from '../window-state.js'
import { profileStore } from '../store/profile-store.js'
import {
  IPC_CHANNELS,
  type BrowserWindowState,
  type BrowserTabState,
} from '../shared/types.js'
import type { WindowManager } from '../window/manager.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface TabIpcDeps {
  windowManager: WindowManager
  /** 获取 IPC 调用方所在的 BrowserWindow */
  getSenderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null
  /** 通过 BrowserWindow 实例反查 windowId */
  findWindowIdByWin: (win: BrowserWindow) => string | null
  /** 创建浏览器窗口（多标签） */
  createBrowserWindow: (windowId: string, profileId: string) => BrowserWindow
}

/** 注册标签相关 IPC handler */
export function registerTabIpc(deps: TabIpcDeps): void {
  const { windowManager, getSenderWindow, findWindowIdByWin, createBrowserWindow } = deps

  // ===== 标签管理 IPC =====
  ipcMain.handle(IPC_CHANNELS.TAB_UPDATE_TITLE, (_e, windowId: string, tabId: string, title: string) => {
    windowStore.updateTabTitle(windowId, tabId, title)
  })
  ipcMain.handle(IPC_CHANNELS.TAB_UPDATE_URL, (_e, windowId: string, tabId: string, url: string) => {
    windowStore.updateTabUrl(windowId, tabId, url)
  })
  ipcMain.handle(IPC_CHANNELS.TAB_UPDATE_HOME_URL, (_e, windowId: string, tabId: string, homeUrl: string) => {
    windowStore.updateTabHomeUrl(windowId, tabId, homeUrl)
  })

  // 标签脱离：隐藏语义——主窗口隐藏该 Profile 的全部标签，
  // 浏览器窗口使用同一个 session partition，保留全部登录态和页面数据。
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, async (e, tabId: string) => {
    const win = getSenderWindow(e)
    if (!win) return
    const sourceWindowId = findWindowIdByWin(win)
    if (!sourceWindowId) return

    const state = windowStore.getOrDefault(sourceWindowId)
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return

    const profileId = tab.profileId

    // 1. 标记该 Profile 为已脱离（主窗口渲染层将隐藏这些标签）
    //    v0.0.9：同时在主窗口 TabState 上记录 detachedWindowId，便于跨窗口归属查询
    const detachedProfiles = state.detachedProfiles ?? []
    if (!detachedProfiles.includes(profileId)) {
      detachedProfiles.push(profileId)
    }
    // 如果当前激活标签属于该 Profile，切换到其他标签
    const newActiveId = state.activeTabId && state.tabs.some((t) => t.id === state.activeTabId && t.profileId === profileId)
      ? (state.tabs.find((t) => t.profileId !== profileId)?.id ?? null)
      : state.activeTabId
    // 为每个脱离的标签标记 detachedWindowId（稍后赋值为 newWindowId）
    const newWindowIdPlaceholder = '__PENDING__'
    const updatedTabs = state.tabs.map((t) =>
      t.profileId === profileId
        ? { ...t, detachedWindowId: newWindowIdPlaceholder }
        : t,
    )
    windowStore.save(sourceWindowId, {
      ...state,
      tabs: updatedTabs,
      detachedProfiles,
      activeTabId: newActiveId,
    })

    // 2. 为浏览器窗口准备 session（仅设置 UA + Client Hints，不创建新 partition）
    await windowManager.setupSession(profileId)

    // 3. 查询 Profile 的 AI 平台信息（用于书签来源快照）
    const profile = profileStore.get(profileId)
    const aiPlatformId = profile?.aiPlatformId
    const platformName = profile?.aiPlatformId
      ? (await import('../presets/ai-platforms.js')).AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)?.name
      : undefined

    // 4. 收集该 Profile 的全部标签，转换为 BrowserTabState
    //    v0.0.9：保留原 TabState.id 作为 parentTabId（跨窗口归属查询用）
    const profileTabs = state.tabs.filter((t) => t.profileId === profileId)
    const browserTabs: BrowserTabState[] = profileTabs.map((t, idx) => ({
      id: randomUUID(),
      profileId,
      title: t.title || '',
      url: t.url || '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      order: idx,
      source: 'initial' as const,
      kind: 'home' as const,
      parentTabId: t.id,
    }))

    if (browserTabs.length === 0) {
      browserTabs.push({
        id: randomUUID(),
        profileId,
        title: tab.title || '',
        url: tab.url || '',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        order: 0,
        source: 'initial',
        kind: 'home',
        parentTabId: tab.id,
      })
    }

    // 5. 保存浏览器窗口状态（含 parentTabId / aiPlatformId / platformName 快照）
    const newWindowId = randomUUID()
    const clickedIdx = profileTabs.findIndex((t) => t.id === tabId)
    const activeBrowserTabId = browserTabs[clickedIdx >= 0 ? clickedIdx : browserTabs.length - 1]?.id ?? null

    const browserState: BrowserWindowState = {
      windowId: newWindowId,
      profileId,
      bounds: { width: 0, height: 0 },
      isMaximized: true,
      isFullscreen: false,
      alwaysOnTop: false,
      activeTabId: activeBrowserTabId,
      tabs: browserTabs,
      parentTabId: tab.id,
      aiPlatformId,
      platformName,
    }
    browserWindowStore.save(newWindowId, browserState)

    // 6. 回填主窗口 TabState 的 detachedWindowId（替换占位符为真实 windowId）
    const refreshedState = windowStore.getOrDefault(sourceWindowId)
    const backfilledTabs = refreshedState.tabs.map((t) =>
      t.detachedWindowId === newWindowIdPlaceholder
        ? { ...t, detachedWindowId: newWindowId }
        : t,
    )
    windowStore.save(sourceWindowId, { ...refreshedState, tabs: backfilledTabs })

    // 7. 清除导航历史
    navHistoryStore.clear(profileId)

    // 8. 通知源窗口渲染层隐藏该 Profile 的标签，并同步新的 activeTabId
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.BROWSER_TAB_DETACHED, profileId, newActiveId)
    }

    // 9. 创建浏览器窗口（使用同一个 partition persist:${profileId}）
    createBrowserWindow(newWindowId, profileId)
  })

  // 浏览器窗口关闭时，恢复主窗口中该 Profile 的标签
  // v0.0.9：按 parentTabId 精确恢复多标签 URL（不再丢失），清除 detachedWindowId
  ipcMain.on(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, (_e, payload: {
    profileId: string
    url: string
    title: string
    finalUrls?: Array<{ tabId: string; url: string; title: string }>
  }) => {
    const mainWindow = windowState.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    // 从主窗口 state 中移除 detachedProfiles 标记，并清除该 profile 标签的 detachedWindowId
    const mainState = windowStore.getOrDefault('main')
    const detachedProfiles = (mainState.detachedProfiles ?? []).filter((id) => id !== payload.profileId)
    // v0.0.9：如果有 finalUrls，按 parentTabId 精确更新主窗口标签的 url/title
    const restoredTabs = mainState.tabs.map((t) => {
      if (t.profileId !== payload.profileId) return t
      const final = payload.finalUrls?.find((f) => f.tabId === t.id)
      return {
        ...t,
        url: final?.url ?? t.url,
        title: final?.title ?? t.title,
        detachedWindowId: null,
      }
    })
    windowStore.save('main', { ...mainState, tabs: restoredTabs, detachedProfiles })

    // 通知主窗口渲染层恢复该 Profile 的标签
    mainWindow.webContents.send(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, payload)

    // 将主窗口带到前台并聚焦
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })
}
