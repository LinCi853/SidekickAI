// electron/store/browser-window-store.ts — 浏览器窗口状态持久化
//
// 独立于 WindowStore（存储 WindowStateData），存储 BrowserWindowState。
// 文件名：browser-windows.json

import type { BrowserWindowState } from '../shared/types.js'
import { createSqliteJsonStore } from './module-state-store.js'

type BrowserWindowStateStore = {
  states: Record<string, BrowserWindowState>
}

const store = createSqliteJsonStore<BrowserWindowStateStore>({
  tableName: 'browser_windows',
  defaults: { states: {} },
})

class BrowserWindowStore {
  /** 读取指定浏览器窗口状态 */
  get(windowId: string): BrowserWindowState | null {
    return store.get('states')[windowId] ?? null
  }

  /** 保存浏览器窗口状态（整体覆盖） */
  save(windowId: string, state: BrowserWindowState): void {
    const states = store.get('states')
    states[windowId] = state
    store.set('states', states)
  }

  /** 删除浏览器窗口状态（窗口关闭时清理） */
  delete(windowId: string): void {
    const states = store.get('states')
    delete states[windowId]
    store.set('states', states)
  }

  /** 列出所有浏览器窗口状态 */
  list(): BrowserWindowState[] {
    return Object.values(store.get('states'))
  }
}

export const browserWindowStore = new BrowserWindowStore()
