// electron/store/window-store.ts — 窗口状态持久化存储
//
// 持久化主窗口与每个脱离窗口的状态：
//   - 窗口 bounds（位置 + 尺寸）
//   - 最大化 / 置顶标记
//   - 标签列表（profileId / title / order）
//   - 激活标签 id
//   - 底栏展开状态
//
// 存储结构：window-states.json
//   {
//     "main": { windowId, bounds, isMaximized, alwaysOnTop, activeTabId, tabs, bottomBarExpanded },
//     "<uuid>": { ... }  // 脱离窗口
//   }

import type { WindowStateData } from '../shared/types.js'
import { createJsonStore } from './store-paths.js'

type WindowStateStore = {
  states: Record<string, WindowStateData>
}

const store = createJsonStore<WindowStateStore>({
  name: 'window-states',
  defaults: { states: {} },
})

/** 主窗口默认 id */
export const MAIN_WINDOW_ID = 'main'

/**
 * 窗口状态持久化：按 windowId 读写。
 */
export class WindowStore {
  /** 读取指定窗口状态 */
  get(windowId: string): WindowStateData | null {
    return store.get('states')[windowId] ?? null
  }

  /** 读取或创建默认窗口状态 */
  getOrDefault(windowId: string): WindowStateData {
    const existing = this.get(windowId)
    if (existing) return existing
    return {
      windowId,
      // 默认窄长形态：略宽于 iPhone viewport 390，高度容纳顶栏 36px + webview + 底栏
      bounds: { width: 420, height: 820 },
      isMaximized: false,
      alwaysOnTop: false,
      activeTabId: null,
      tabs: [],
      bottomBarExpanded: false,
    }
  }

  /**
   * 校验窗口状态中的 tabs 数组，过滤掉异常数据（防止白屏）。
   * - 过滤掉非对象 / 缺 id 的 tab
   * - 过滤掉 url 非 http(s):// 且非空 的 tab（空 url 用 profile.aiPlatformUrl 兜底，合法）
   * - 过滤掉 url 长度异常（> 2048）的 tab
   * 若 tabs 数组变化，返回 true 表示调用方应持久化。
   */
  sanitizeTabs(windowId: string): boolean {
    const state = this.get(windowId)
    if (!state || !Array.isArray(state.tabs)) return false
    const originalLen = state.tabs.length
    const sanitized = state.tabs.filter((t) => {
      if (!t || typeof t !== 'object') return false
      if (!t.id || typeof t.id !== 'string') return false
      const url = t.url
      // url 可选：未设置时用 profile.aiPlatformUrl，合法
      if (url === undefined || url === '') return true
      if (typeof url !== 'string') return false
      if (url.length > 2048) return false
      // 必须是 http(s):// 开头（防止 file:// / chrome:// / about: 等导致挂载失败）
      if (!/^https?:\/\//i.test(url)) return false
      return true
    })
    if (sanitized.length !== originalLen) {
      console.warn(
        `[window-store] tabs 数据异常，已过滤 ${originalLen - sanitized.length} 个无效 tab (windowId=${windowId})`,
      )
      state.tabs = sanitized
      // 若 activeTabId 指向的 tab 已被过滤，重置为 null
      if (state.activeTabId && !sanitized.some((t) => t.id === state.activeTabId)) {
        state.activeTabId = sanitized.length > 0 ? sanitized[0].id : null
      }
      this.save(windowId, state)
      return true
    }
    return false
  }

  /** 保存窗口状态（整体覆盖） */
  save(windowId: string, state: WindowStateData): void {
    const states = store.get('states')
    states[windowId] = state
    store.set('states', states)
  }

  /** 删除窗口状态（脱离窗口关闭时清理） */
  remove(windowId: string): void {
    if (windowId === MAIN_WINDOW_ID) return // 主窗口状态不删
    const states = store.get('states')
    delete states[windowId]
    store.set('states', states)
  }

  /** 列出所有脱离窗口的 id（排除 main） */
  listDetachedWindowIds(): string[] {
    const states = store.get('states')
    return Object.keys(states).filter((id) => id !== MAIN_WINDOW_ID)
  }

  /** 列出所有 chat 模式脱离窗口状态（mode='chat'） */
  listChatWindows(): WindowStateData[] {
    const states = store.get('states')
    return Object.values(states).filter(
      (s) => s.windowId !== MAIN_WINDOW_ID && s.mode === 'chat',
    )
  }

  /** 更新 chat 模式脱离窗口的 chatConfig */
  updateChatConfig(windowId: string, config: WindowStateData['chatConfig']): void {
    const state = this.get(windowId)
    if (!state) return
    state.chatConfig = config
    this.save(windowId, state)
  }

  /**
   * 更新指定窗口的最近使用时间戳为当前时间。
   * 由 AppSwitcher 显示/创建自定义对话窗口时调用，
   * 供 AppSwitcher 按 lastUsedAt 降序排列（从未使用 / 过期的落在最后）。
   */
  touchLastUsed(windowId: string): void {
    const state = this.get(windowId)
    if (!state) return
    state.lastUsedAt = Date.now()
    this.save(windowId, state)
  }

  /** 更新单个标签标题 */
  updateTabTitle(windowId: string, tabId: string, title: string): void {
    this.updateTabField(windowId, tabId, 'title', title)
  }

  /** 更新单个标签 URL */
  updateTabUrl(windowId: string, tabId: string, url: string): void {
    this.updateTabField(windowId, tabId, 'url', url)
  }

  /** 更新单个标签首页地址 */
  updateTabHomeUrl(windowId: string, tabId: string, homeUrl: string): void {
    this.updateTabField(windowId, tabId, 'homeUrl', homeUrl)
  }

  /**
   * 通用标签字段更新（read-modify-write）。
   * 供 updateTabTitle / updateTabUrl / updateTabHomeUrl 复用，仅字段名不同。
   */
  private updateTabField(
    windowId: string,
    tabId: string,
    field: 'title' | 'url' | 'homeUrl',
    value: string,
  ): void {
    const state = this.get(windowId)
    if (!state) return
    state.tabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, [field]: value } : t,
    )
    this.save(windowId, state)
  }
}

export const windowStore = new WindowStore()
