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
import { windowStore } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import { detachProfileToBrowserWindow } from '../window-factory/detach-profile.js'
import { IPC_CHANNELS } from '../shared/types.js'
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
  const { getSenderWindow, findWindowIdByWin, createBrowserWindow } = deps

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

  // 标签脱离：隐藏语义--主窗口隐藏该 Profile 的全部标签，
  // 浏览器窗口使用同一个 session partition，保留全部登录态和页面数据。
  // 核心逻辑抽取到 detach-profile.ts，与 toggleBrowserWindow（窗口快捷键）共用。
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, async (e, tabId: string) => {
    const win = getSenderWindow(e)
    if (!win) return
    const sourceWindowId = findWindowIdByWin(win)
    if (!sourceWindowId) return
    await detachProfileToBrowserWindow(sourceWindowId, tabId, { createBrowserWindow })
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
