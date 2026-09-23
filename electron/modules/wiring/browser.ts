// electron/modules/wiring/browser.ts — 浏览器模块接线（init / teardown / clearData）
//
// 页面冻结（防撤回）暂随本模块（决策 0.8：设计可能变动，最后改造）。
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../shared/types.js'
import { EffectScope } from '../effect-scope.js'
import { registerBrowserIpc } from '../../ipc/browser-ipc.js'
import { registerBrowserTabAudioIpc } from '../../ipc/browser-tab-audio-ipc.js'
import { registerCursorIpc } from '../../utils/cursor.js'
import { createBrowserWindow, showHistoryDownloadWindow } from '../../window-factory.js'
import { searchHistoryStore, closeSearchHistoryStore } from '../../store/search-history-store.js'
import { browserDownloadStore, closeBrowserDownloadStore } from '../../store/browser-download-store.js'
import { closeBookmarkStore } from '../../store/bookmark-store.js'
import { browserWindowStore } from '../../store/browser-window-store.js'
import { windowState } from '../../window-state.js'
import { resolveSqlitePath } from '../../store/store-paths.js'
import fs from 'fs'

/** 模块级 EffectScope */
const scope = new EffectScope('browser', 'browser')

const BROWSER_CHANNELS = [
  IPC_CHANNELS.BROWSER_GET_STATE,
  IPC_CHANNELS.BROWSER_SAVE_STATE,
  IPC_CHANNELS.BROWSER_NEW_TAB,
  IPC_CHANNELS.BROWSER_CLOSE_TAB,
  IPC_CHANNELS.BROWSER_SWITCH_TAB,
  IPC_CHANNELS.BROWSER_NAVIGATE,
  IPC_CHANNELS.BROWSER_CURSOR_POS,
  IPC_CHANNELS.BROWSER_CLOUD_PC_SET,
  IPC_CHANNELS.BROWSER_OPEN_EXTERNAL,
  IPC_CHANNELS.BROWSER_SAVE_PAGE_AS,
  IPC_CHANNELS.BROWSER_DOWNLOAD_AS,
  IPC_CHANNELS.BROWSER_VIEW_SOURCE,
  IPC_CHANNELS.BROWSER_PRINT_PREVIEW,
  IPC_CHANNELS.BROWSER_SAVE_PDF_AS,
  IPC_CHANNELS.BROWSER_DELETE_TEMP_PDF,
  IPC_CHANNELS.BROWSER_SAVE_CAPTURE,
  IPC_CHANNELS.BROWSER_SEARCH_HISTORY_ADD,
  IPC_CHANNELS.BROWSER_SEARCH_HISTORY_LIST,
  IPC_CHANNELS.BROWSER_DOWNLOAD_LIST,
  IPC_CHANNELS.BROWSER_DOWNLOAD_OPEN_FILE,
  IPC_CHANNELS.BROWSER_DOWNLOAD_SHOW_IN_FOLDER,
  IPC_CHANNELS.BROWSER_DOWNLOAD_DELETE,
  IPC_CHANNELS.BROWSER_DOWNLOAD_CLEAR_ALL,
  IPC_CHANNELS.BROWSER_TOGGLE_DEVTOOLS,
  IPC_CHANNELS.BROWSER_TOGGLE_FULLSCREEN,
  IPC_CHANNELS.BOOKMARK_LIST,
  IPC_CHANNELS.BOOKMARK_ADD,
  IPC_CHANNELS.BOOKMARK_UPDATE,
  IPC_CHANNELS.BOOKMARK_DELETE,
  IPC_CHANNELS.BOOKMARK_REORDER,
  IPC_CHANNELS.HISTORY_DOWNLOAD_OPEN,
  IPC_CHANNELS.CURSOR_SET,
]

export function initBrowserModule(): void {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  void scope.dispose().then(() => {
    // 传递 scope 给 registerBrowserIpc，使其使用 EffectScope 管理 IPC handler
    registerBrowserIpc({
      createBrowserWindow,
      getSearchHistoryStore: () => searchHistoryStore,
      getDownloadStore: () => browserDownloadStore,
    }, scope)
    registerBrowserTabAudioIpc({})
    registerCursorIpc()
    scope.ipcHandle(IPC_CHANNELS.HISTORY_DOWNLOAD_OPEN, () => {
      showHistoryDownloadWindow()
    })
  })
}

export function teardownBrowserModule(): void {
  // 1. 关闭全部浏览器窗口（脱离/回归入口随之失效）
  for (const win of windowState.browserWindowsByProfile.values()) {
    if (win && !win.isDestroyed()) {
      try {
        win.close()
      } catch (err) {
        console.warn('[wiring:browser] 关闭浏览器窗口失败:', err)
      }
    }
  }
  // 2. 卸载通道
  void scope.dispose()
  // 3. 关闭数据库句柄
  try { closeSearchHistoryStore() } catch (err) { console.warn('[wiring:browser] close search-history:', err) }
  try { closeBrowserDownloadStore() } catch (err) { console.warn('[wiring:browser] close download:', err) }
  try { closeBookmarkStore() } catch (err) { console.warn('[wiring:browser] close bookmark:', err) }
}

export function clearBrowserData(): void {
  teardownBrowserModule()
  for (const name of ['bookmarks.db', 'browser-downloads.db', 'search-history.db']) {
    const p = resolveSqlitePath(name)
    for (const f of [p, p + '-wal', p + '-shm']) {
      if (fs.existsSync(f)) fs.rmSync(f, { force: true })
    }
  }
  // browserWindowStore 为 electron-store JSON：逐条删除（内存态 + 落盘一并清空）
  try {
    for (const st of browserWindowStore.list()) {
      browserWindowStore.delete(st.windowId)
    }
  } catch (err) {
    console.warn('[wiring:browser] 清空浏览器窗口状态失败:', err)
  }
  console.log('[wiring:browser] 数据已清除')
}
