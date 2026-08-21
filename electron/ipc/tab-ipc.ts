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
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { windowStore } from '../store/window-store.js'
import { profileStore } from '../store/profile-store.js'
import { windowState } from '../window-state.js'
import { detachProfileToBrowserWindow } from '../window-factory/detach-profile.js'
import { isModuleEnabled } from '../modules/registry.js'
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

/**
 * 注册标签相关 IPC handler。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerTabIpc(deps: TabIpcDeps, scope?: EffectScope): void {
  const { getSenderWindow, findWindowIdByWin, createBrowserWindow } = deps

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== 标签管理 IPC =====
  handle(IPC_CHANNELS.TAB_UPDATE_TITLE, (_e: unknown, windowId: string, tabId: string, title: string) => {
    windowStore.updateTabTitle(windowId, tabId, title)
  })
  handle(IPC_CHANNELS.TAB_UPDATE_URL, (_e: unknown, windowId: string, tabId: string, url: string) => {
    windowStore.updateTabUrl(windowId, tabId, url)
  })
  handle(IPC_CHANNELS.TAB_UPDATE_HOME_URL, (_e: unknown, windowId: string, tabId: string, homeUrl: string) => {
    windowStore.updateTabHomeUrl(windowId, tabId, homeUrl)
  })

  // 标签脱离：隐藏语义--主窗口隐藏该 Profile 的全部标签，
  // 浏览器窗口使用同一个 session partition，保留全部登录态和页面数据。
  // 核心逻辑抽取到 detach-profile.ts，与 toggleBrowserWindow（窗口快捷键）共用。
  handle(IPC_CHANNELS.WIN_CONTROL_DETACH_TAB, async (e: unknown, tabId: string) => {
    // 模块门控（11.10）：浏览器模块关闭时禁止标签脱离到浏览器窗口
    if (!isModuleEnabled('browser')) return
    const win = getSenderWindow(e as IpcMainInvokeEvent)
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
    finalUrls?: Array<{ parentTabId?: string; url: string; title: string }>
  }) => {
    const mainWindow = windowState.mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) return

    // 从主窗口 state 中移除 detachedProfiles 标记，并清除该 profile 标签的 detachedWindowId
    const mainState = windowStore.getOrDefault('main')
    const detachedProfiles = (mainState.detachedProfiles ?? []).filter((id) => id !== payload.profileId)
    // v0.0.9：如果有 finalUrls，按 parentTabId 精确更新主窗口标签的 url。
    // 标题显式恢复为 AI 应用名（Profile.name）——主窗口标签/顶栏始终显示应用名，
    // 不随浏览器窗口内浏览的网页标题变化；即使持久化状态曾被覆盖也在此纠正。
    const profileName = profileStore.get(payload.profileId)?.name ?? null
    const restoredTabs = mainState.tabs.map((t) => {
      if (t.profileId !== payload.profileId) return t
      const final = payload.finalUrls?.find((f) => f.parentTabId === t.id)
      return {
        ...t,
        url: final?.url ?? t.url,
        title: profileName ?? t.title,
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
