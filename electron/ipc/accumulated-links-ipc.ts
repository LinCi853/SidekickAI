// electron/ipc/accumulated-links-ipc.ts — 累积链接 IPC 注册（E1）
//
// 渲染层（BrowserView）在窗口初始化后通过 consume 取出累积链接并转为标签。
// 主窗口 helpers.ts 在拦截 webview new-window 时直接调用 store.add（不经 IPC），
// 此处 IPC 仅供渲染层主动查询/消费/清空使用。
//
// 持久化模式由 AppSettings.browserTabPersistence 决定：
//   - 'memory'（默认）→ persistent=false
//   - 'persistent'      → persistent=true

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { accumulatedLinksStore, type AccumulatedLink } from '../store/accumulated-links-store.js'
import { getAppSettings } from '../store/app-settings-store.js'

/** 读取持久化模式开关：true=SQLite / false=内存 */
function isPersistent(): boolean {
  try {
    return getAppSettings().browserTabPersistence === 'persistent'
  } catch {
    return false
  }
}

/** 注册累积链接相关 IPC handler */
export function registerAccumulatedLinksIpc(): void {
  // 添加一条累积链接
  ipcMain.handle(
    IPC_CHANNELS.ACCUMULATED_LINK_ADD,
    (_e, profileId: string, url: string, title: string) => {
      accumulatedLinksStore.add(profileId, url, title, isPersistent())
      return true
    },
  )

  // 列出指定 Profile 的全部累积链接
  ipcMain.handle(
    IPC_CHANNELS.ACCUMULATED_LINK_LIST,
    (_e, profileId: string): AccumulatedLink[] => {
      return accumulatedLinksStore.list(profileId, isPersistent())
    },
  )

  // 取出并清空指定 Profile 的全部累积链接
  ipcMain.handle(
    IPC_CHANNELS.ACCUMULATED_LINK_CONSUME,
    (_e, profileId: string): AccumulatedLink[] => {
      return accumulatedLinksStore.consume(profileId, isPersistent())
    },
  )

  // 清空指定 Profile 的全部累积链接
  ipcMain.handle(
    IPC_CHANNELS.ACCUMULATED_LINK_CLEAR,
    (_e, profileId: string) => {
      accumulatedLinksStore.clear(profileId, isPersistent())
      return true
    },
  )
}
