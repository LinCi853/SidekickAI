// electron/ipc/nav-history-ipc.ts — 导航历史持久化 CRUD IPC 注册
//
// 注册 NAV_HISTORY_LIST / SEARCH / DELETE / CLEAR_ALL handler，
// 供历史记录与下载管理独立窗口的「导航历史」面板调用。
// 基础的 record / get / clear 仍由 browser-ipc.ts 注册（脱离标签流程使用）。
//
// 在 app.whenReady 后由 main.ts 调用 registerNavHistoryIpc() 完成注册。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { navHistoryStore } from '../store/nav-history-store.js'

/** 注册导航历史 CRUD IPC handler */
export function registerNavHistoryIpc(): void {
  // 分页列表（按时间倒序；profileId 省略时跨 Profile 聚合）
  ipcMain.handle(
    IPC_CHANNELS.NAV_HISTORY_LIST,
    (_e, profileId: string | undefined, page: number, pageSize: number) => {
      return navHistoryStore.list(profileId, page ?? 1, pageSize ?? 50)
    },
  )

  // 关键词搜索（URL / title 模糊匹配；profileId 省略时跨 Profile 聚合）
  ipcMain.handle(
    IPC_CHANNELS.NAV_HISTORY_SEARCH,
    (_e, profileId: string | undefined, keyword: string) => {
      return navHistoryStore.search(profileId, keyword ?? '')
    },
  )

  // 删除单条
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_DELETE, (_e, id: string) => {
    navHistoryStore.delete(id)
  })

  // 清空全部（可选按 profileId）
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_CLEAR_ALL, (_e, profileId?: string) => {
    navHistoryStore.clearAll(profileId)
  })
}
