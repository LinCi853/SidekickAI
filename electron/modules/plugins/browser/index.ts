// electron/modules/plugins/browser/index.ts — 浏览器模块接线（init / teardown / clearData）
//
//
// 已迁移到统一注入管线（EffectScope）。

import { IPC_CHANNELS } from '../../../shared/types.js'
import { EffectScope } from '../../effect-scope.js'
import { registerBrowserIpc } from '../../../browser/browser-ipc.js'
import { registerBrowserTabAudioIpc } from '../../../browser/browser-tab-audio-ipc.js'
import { registerCursorIpc } from '../../../utils/cursor.js'
import { createBrowserWindow, showHistoryDownloadWindow } from '../../../window-factory.js'
import { searchHistoryStore, closeSearchHistoryStore } from '../../../browser/search-history-store.js'
import { browserDownloadStore, closeBrowserDownloadStore } from '../../../browser/browser-download-store.js'
import { closeBookmarkStore } from '../../../browser/bookmark-store.js'
import { browserWindowStore } from '../../../browser/browser-window-store.js'
import { windowState } from '../../../platform/window/window-state.js'
import { resolveSqlitePath } from '../../../store/store-paths.js'
import fs from 'fs'

/** 模块级 EffectScope */
const scope = new EffectScope('browser', 'browser')


export async function initBrowserModule(): Promise<void> {
  // 幂等：先清理旧注册再注册（init 重入/热重载安全）
  await scope.dispose()
  // 传递 scope 给 registerBrowserIpc，使其使用 EffectScope 管理 IPC handler
  registerBrowserIpc({
    createBrowserWindow,
    getSearchHistoryStore: () => searchHistoryStore,
    getDownloadStore: () => browserDownloadStore,
  }, scope)
  registerBrowserTabAudioIpc({})
  registerCursorIpc(scope)
  scope.ipcHandle(IPC_CHANNELS.HISTORY_DOWNLOAD_OPEN, () => {
    showHistoryDownloadWindow()
  })
}

export async function teardownBrowserModule(): Promise<void> {
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
  await scope.dispose()
  // 3. 关闭数据库句柄
  try { closeSearchHistoryStore() } catch (err) { console.warn('[wiring:browser] close search-history:', err) }
  try { closeBrowserDownloadStore() } catch (err) { console.warn('[wiring:browser] close download:', err) }
  try { closeBookmarkStore() } catch (err) { console.warn('[wiring:browser] close bookmark:', err) }
}

export async function clearBrowserData(): Promise<void> {
  await teardownBrowserModule()
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
