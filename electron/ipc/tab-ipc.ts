// electron/ipc/tab-ipc.ts — 标签相关 IPC 注册
//
// 包含：
//   - 标签 CRUD（TAB_UPDATE_TITLE / TAB_UPDATE_URL / TAB_UPDATE_HOME_URL）
//   - 标签脱离（WIN_CONTROL_DETACH_TAB，复制语义：源窗口保留 tab，
//     新窗口按同 partition + 同 URL 加载，登录态/session 由 partition 自动共享）
//
// 在 app.whenReady 后由 main.ts 调用 registerTabIpc(deps) 完成注册。

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import { windowStore } from '../store/window-store.js'
import { IPC_CHANNELS, type WindowStateData } from '../shared/types.js'
import type { WindowManager } from '../window/manager.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface TabIpcDeps {
  windowManager: WindowManager
  /** 获取 IPC 调用方所在的 BrowserWindow */
  getSenderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null
  /** 通过 BrowserWindow 实例反查 windowId */
  findWindowIdByWin: (win: BrowserWindow) => string | null
  /** 创建脱离窗口（单标签独立窗口） */
  createStandaloneWindow: (windowId: string) => BrowserWindow
}

/** 注册标签相关 IPC handler */
export function registerTabIpc(deps: TabIpcDeps): void {
  const { windowManager, getSenderWindow, findWindowIdByWin, createStandaloneWindow } = deps

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

  // 标签脱离：复制语义——源窗口保留 tab（webview 不卸载），
  // 新窗口按同 partition + 同 URL 加载，登录态/session 由 partition 自动共享
  ipcMain.handle(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, async (e, tabId: string) => {
    const win = getSenderWindow(e)
    if (!win) return
    const sourceWindowId = findWindowIdByWin(win)
    if (!sourceWindowId) return

    const state = windowStore.getOrDefault(sourceWindowId)
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return

    // 不再从源窗口 state 移除 tab（复制语义：源 webview 保留页面状态）
    // 为脱离标签准备 session（新窗口 webview 用同 partition 共享登录态）
    await windowManager.setupSession(tab.profileId)

    // 创建独立窗口（新窗口的 tab 用新 id，避免与源 tab 冲突）
    const newWindowId = randomUUID()
    const newTabId = randomUUID()
    const newState: WindowStateData = {
      windowId: newWindowId,
      bounds: {
        width: 390,
        height: 844,
        x: win.getBounds().x + 40,
        y: win.getBounds().y + 40,
      },
      isMaximized: false,
      alwaysOnTop: false,
      activeTabId: newTabId,
      tabs: [{ ...tab, id: newTabId, order: 0 }],
      bottomBarExpanded: false,
    }
    windowStore.save(newWindowId, newState)
    createStandaloneWindow(newWindowId)
  })
}
