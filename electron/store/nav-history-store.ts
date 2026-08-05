// electron/store/nav-history-store.ts — 内存导航历史追踪器
//
// 追踪每个 Profile 在主窗口中的导航历史。
// 当用户脱离标签为浏览器窗口时，历史被传递给新窗口作为初始标签。
// 重启后清空（当前会话语义）。

import type { NavHistoryEntry } from '../shared/types.js'

class NavHistoryStore {
  private history = new Map<string, NavHistoryEntry[]>()

  /** 记录一次导航（去重：同 URL 连续不重复记录） */
  record(profileId: string, entry: NavHistoryEntry): void {
    const list = this.history.get(profileId) ?? []
    const last = list[list.length - 1]
    if (last && last.url === entry.url) {
      last.title = entry.title || last.title
      return
    }
    list.push(entry)
    this.history.set(profileId, list)
  }

  /** 获取某 Profile 的全部导航历史 */
  get(profileId: string): NavHistoryEntry[] {
    return this.history.get(profileId) ?? []
  }

  /** 清除某 Profile 的历史（脱离后清除，避免重复） */
  clear(profileId: string): void {
    this.history.delete(profileId)
  }
}

export const navHistoryStore = new NavHistoryStore()
