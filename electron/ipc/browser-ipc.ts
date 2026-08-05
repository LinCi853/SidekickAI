// electron/ipc/browser-ipc.ts — 浏览器窗口 IPC 注册
//
// v0.0.9：多标签浏览器窗口相关 IPC handler。
// 包含：窗口状态 CRUD / 标签操作 / 外部打开 / 搜索历史 / 下载 / 导航历史
//
// 在 app.whenReady 后由 main.ts 调用 registerBrowserIpc(deps) 完成注册。

import { ipcMain, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type {
  BrowserWindowState,
  BrowserTabState,
  NavHistoryEntry,
  BrowserDownloadRecord,
  SearchHistoryEntry,
} from '../shared/types.js'
import type { BookmarkInput, BookmarkFilter, BookmarkPatch } from '../shared/bookmark.types.js'
import { browserWindowStore } from '../store/browser-window-store.js'
import { navHistoryStore } from '../store/nav-history-store.js'
import { bookmarkStore } from '../store/bookmark-store.js'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface BrowserIpcDeps {
  /** 创建浏览器窗口 */
  createBrowserWindow: (windowId: string, profileId: string) => BrowserWindow
  /** 获取搜索历史 store（Phase 6 注入，可选） */
  getSearchHistoryStore?: () => {
    add: (entry: { profileId: string; query: string; url: string }) => void
    list: (profileId: string, keyword?: string, limit?: number) => SearchHistoryEntry[]
  } | null
  /** 获取下载 store（Phase 6 注入，可选） */
  getDownloadStore?: () => {
    list: (windowId?: string, limit?: number) => BrowserDownloadRecord[]
    get: (id: string) => BrowserDownloadRecord | null
  } | null
}

/** 获取调用方所在的 BrowserWindow */
function getSenderWindow(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/** 注册浏览器窗口相关 IPC handler */
export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  // ===== 窗口状态 =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_GET_STATE, (_e, windowId: string) => {
    return browserWindowStore.get(windowId)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SAVE_STATE, (_e, windowId: string, state: BrowserWindowState) => {
    browserWindowStore.save(windowId, state)
  })

  // ===== 标签操作 =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_NEW_TAB, (_e, windowId: string, tab: BrowserTabState) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs.push(tab)
    state.activeTabId = tab.id
    browserWindowStore.save(windowId, state)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_CLOSE_TAB, (_e, windowId: string, tabId: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs = state.tabs.filter((t) => t.id !== tabId)
    if (state.activeTabId === tabId) {
      state.activeTabId = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1].id : null
    }
    browserWindowStore.save(windowId, state)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SWITCH_TAB, (_e, windowId: string, tabId: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.activeTabId = tabId
    browserWindowStore.save(windowId, state)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_NAVIGATE, (_e, windowId: string, tabId: string, url: string) => {
    const state = browserWindowStore.get(windowId)
    if (!state) return
    state.tabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, url } : t,
    )
    browserWindowStore.save(windowId, state)
  })

  // ===== 外部浏览器打开 =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, (_e, url: string) => {
    return shell.openExternal(url)
  })

  // ===== 搜索历史 =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_ADD, (_e, entry: { profileId: string; query: string; url: string }) => {
    const store = deps.getSearchHistoryStore?.()
    if (store) store.add(entry)
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_LIST, (_e, profileId: string, keyword?: string, limit?: number) => {
    const store = deps.getSearchHistoryStore?.()
    return store ? store.list(profileId, keyword, limit) : []
  })

  // ===== 下载记录 =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_LIST, (_e, windowId?: string, limit?: number) => {
    const store = deps.getDownloadStore?.()
    return store ? store.list(windowId, limit) : []
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN_FILE, async (_e, id: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    const record = store.get(id)
    if (!record) return { ok: false, error: 'record not found' }
    try {
      await shell.openPath(record.savePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DOWNLOAD_SHOW_IN_FOLDER, (_e, id: string) => {
    const store = deps.getDownloadStore?.()
    if (!store) return { ok: false, error: 'download store not available' }
    const record = store.get(id)
    if (!record) return { ok: false, error: 'record not found' }
    try {
      shell.showItemInFolder(record.savePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ===== 导航历史 =====

  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_RECORD, (_e, profileId: string, entry: NavHistoryEntry) => {
    navHistoryStore.record(profileId, entry)
  })

  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_GET, (_e, profileId: string) => {
    return navHistoryStore.get(profileId)
  })

  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_CLEAR, (_e, profileId: string) => {
    navHistoryStore.clear(profileId)
  })

  // ===== 书签系统（v0.0.9） =====

  ipcMain.handle(IPC_CHANNELS.BOOKMARK_LIST, (_e, filter?: BookmarkFilter) => {
    return bookmarkStore.list(filter)
  })

  ipcMain.handle(IPC_CHANNELS.BOOKMARK_ADD, (_e, input: BookmarkInput) => {
    return bookmarkStore.add(input)
  })

  ipcMain.handle(IPC_CHANNELS.BOOKMARK_UPDATE, (_e, id: string, patch: BookmarkPatch) => {
    return bookmarkStore.update(id, patch)
  })

  ipcMain.handle(IPC_CHANNELS.BOOKMARK_DELETE, (_e, id: string) => {
    bookmarkStore.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.BOOKMARK_REORDER, (_e, ids: string[]) => {
    bookmarkStore.reorder(ids)
  })

  // ===== 聚焦浏览器窗口 =====
  ipcMain.handle(IPC_CHANNELS.BROWSER_FOCUS_WINDOW, (_e, windowId: string) => {
    const win = windowState.detachedWindows.get(windowId)
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
      return true
    }
    return false
  })

  // ===== 跨窗口标签聚合查询（v0.0.9，主子标签归属） =====

  ipcMain.handle(IPC_CHANNELS.BROWSER_TABS_QUERY, () => {
    // 聚合主窗口标签 + 所有浏览器窗口标签，返回树结构
    // 主窗口标签（TabState[]，含 detachedWindowId 标记哪些已脱离）
    const mainWindowState = windowStore.get(MAIN_WINDOW_ID)
    const mainTabs = mainWindowState?.tabs ?? []
    // 所有浏览器窗口（BrowserWindowState[]，含 parentTabId 关联到主窗口标签）
    const browsers = browserWindowStore.list().map((state) => ({
      windowId: state.windowId,
      parentTabId: state.parentTabId ?? null,
      profileId: state.profileId,
      platformName: state.platformName ?? null,
      tabs: state.tabs,
    }))
    return { main: mainTabs, browsers }
  })
}
