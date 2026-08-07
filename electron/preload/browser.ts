import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type BrowserDownloadRecord, type BookmarkInput, type BookmarkPatch, type AccumulatedLink, type MigratedTabInfo } from '../shared/types.js'

export const browserApi = {
  // ===== 浏览器窗口（v0.0.9：多标签浏览器） =====
  browser: {
    getState: (windowId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_STATE, windowId),
    saveState: (windowId: string, state: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SAVE_STATE, windowId, state),
    openExternal: (url: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_OPEN_EXTERNAL, url),
    addSearchHistory: (entry: { profileId: string; query: string; url: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_ADD, entry),
    listSearchHistory: (profileId: string, keyword?: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SEARCH_HISTORY_LIST, profileId, keyword, limit),
    listDownloads: (windowId?: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_LIST, windowId, limit),
    openDownloadFile: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN_FILE, id),
    showDownloadInFolder: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_SHOW_IN_FOLDER, id),
    deleteDownload: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_DELETE, id),
    clearAllDownloads: (windowId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DOWNLOAD_CLEAR_ALL, windowId),
    onDownloadUpdated: (callback: (record: BrowserDownloadRecord) => void) => {
      const handler = (_e: unknown, record: unknown) => callback(record as Parameters<typeof callback>[0])
      ipcRenderer.on(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_DOWNLOAD_UPDATED, handler)
    },
    onToggleDevTools: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TOGGLE_DEVTOOLS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TOGGLE_DEVTOOLS, handler)
    },
    onToggleFullscreen: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TOGGLE_FULLSCREEN, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TOGGLE_FULLSCREEN, handler)
    },
    tabMigrateBack: (payload: { profileId: string; url: string; title: string; finalUrls?: MigratedTabInfo[] }) => {
      ipcRenderer.send(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, payload)
    },
    onTabMigrateBack: (callback: (payload: { profileId: string; url: string; title: string; finalUrls?: MigratedTabInfo[] }) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload as Parameters<typeof callback>[0])
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK, handler)
    },
    /** 主→渲染：标签已脱离到浏览器窗口（载荷：profileId, newActiveTabId） */
    onTabDetached: (callback: (profileId: string, newActiveTabId: string | null) => void) => {
      const handler = (_e: unknown, profileId: unknown, newActiveTabId: unknown) => callback(profileId as string, newActiveTabId as string | null)
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_DETACHED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_DETACHED, handler)
    },
    /** 主→渲染：标签音频状态变化（页面开始/停止播放音频） */
    onTabAudioChanged: (callback: (payload: { windowId: string; tabId: string; audible: boolean }) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload as Parameters<typeof callback>[0])
      ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_AUDIO_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_AUDIO_CHANGED, handler)
    },
    /** 跨窗口标签聚合查询（主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签） */
    queryAllTabs: () =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TABS_QUERY),
    /** 聚焦指定浏览器窗口 */
    focusWindow: (windowId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.BROWSER_FOCUS_WINDOW, windowId),
    // ===== 书签系统（v0.0.9） =====
    bookmark: {
      list: (filter?: { profileId?: string; barOnly?: boolean }) =>
        ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_LIST, filter),
      add: (input: BookmarkInput) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_ADD, input),
      update: (id: string, patch: BookmarkPatch) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_UPDATE, id, patch),
      delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_DELETE, id),
      reorder: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARK_REORDER, ids),
    },
    // ===== E1：AI 应用内新窗口链接累积 =====
    accumulatedLinks: {
      add: (profileId: string, url: string, title: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.ACCUMULATED_LINK_ADD, profileId, url, title),
      list: (profileId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.ACCUMULATED_LINK_LIST, profileId) as Promise<AccumulatedLink[]>,
      consume: (profileId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.ACCUMULATED_LINK_CONSUME, profileId) as Promise<AccumulatedLink[]>,
      clear: (profileId: string) =>
        ipcRenderer.invoke(IPC_CHANNELS.ACCUMULATED_LINK_CLEAR, profileId),
    },
  },
  // ===== 导航历史追踪 =====
  navHistory: {
    record: (profileId: string, entry: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_RECORD, profileId, entry),
    get: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_GET, profileId),
    clear: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_CLEAR, profileId),
    list: (profileId: string | undefined, page: number, pageSize: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_LIST, profileId, page, pageSize),
    search: (profileId: string | undefined, keyword: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_SEARCH, profileId, keyword),
    delete: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_DELETE, id),
    clearAll: (profileId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NAV_HISTORY_CLEAR_ALL, profileId),
  },
  // 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
  // 将 URL + guest webContents id 发回渲染层，由渲染层在匹配的当前 webview 内导航）
  onWebviewPopupUrl: (
    callback: (payload: { url: string; webContentsId: number }) => void,
  ) => {
    const handler = (
      _e: unknown,
      payload: { url: string; webContentsId: number },
    ) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_POPUP_URL, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_POPUP_URL, handler)
  },
  // 新标签页（主进程拦截 webview 弹窗后 → 渲染层）
  onNewTab: (callback: (url: string, windowId: string) => void) => {
    const handler = (_e: unknown, url: string, windowId: string) => callback(url, windowId)
    ipcRenderer.on(IPC_CHANNELS.RENDERER_NEW_TAB, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.RENDERER_NEW_TAB, handler)
  },
}
