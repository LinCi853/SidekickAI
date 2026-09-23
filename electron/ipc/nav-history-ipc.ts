import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { NavHistoryEntry } from '../shared/types.js'
import { navHistoryStore } from '../store/nav-history-store.js'

/** Navigation history is shared by main windows and optional browser windows. */
export function registerNavHistoryIpc(): void {
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_RECORD, (_event, profileId: string, entry: NavHistoryEntry) => {
    navHistoryStore.record(profileId, entry)
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_GET, (_event, profileId: string) => {
    return navHistoryStore.get(profileId)
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_CLEAR, (_event, profileId: string) => {
    navHistoryStore.clear(profileId)
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_LIST, (_event, profileId: string | undefined, page: number, pageSize: number) => {
    return navHistoryStore.list(profileId, page ?? 1, pageSize ?? 50)
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_SEARCH, (_event, profileId: string | undefined, keyword: string) => {
    return navHistoryStore.search(profileId, keyword ?? '')
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_DELETE, (_event, id: string) => {
    navHistoryStore.delete(id)
  })
  ipcMain.handle(IPC_CHANNELS.NAV_HISTORY_CLEAR_ALL, (_event, profileId?: string) => {
    navHistoryStore.clearAll(profileId)
  })
}
