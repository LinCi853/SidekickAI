// electron/window-factory/detach-profile.ts - 标签脱离核心逻辑（共享）
//
// 将主窗口（或任意源窗口）中指定 Profile 的标签脱离为独立浏览器窗口。
// 语义：主窗口隐藏该 Profile 的全部标签（标记 detachedProfiles + detachedWindowId），
//       浏览器窗口使用同一个 session partition（persist:${profileId}），保留登录态与页面数据；
//       浏览器窗口关闭时通过 closed 事件触发 MIGRATE_BACK，标签回归主窗口。
//
// 抽取自 tab-ipc.ts 的 WIN_CONTROL_DETACH_TAB handler，供两处复用：
//   1. tab-ipc.ts DETACH_TAB handler（渲染层主动脱离：右键菜单/Ctrl+T/拖拽）
//   2. browser-window.ts toggleBrowserWindow（窗口快捷键脱离分支）
//
// 关键：所有脱离的浏览器窗口都带 parentTabId，确保关闭时回归主窗口（而非简单关闭）。

import { randomUUID } from 'crypto'
import { windowStore } from '../store/window-store.js'
import { browserWindowStore } from '../store/browser-window-store.js'
import { navHistoryStore } from '../store/nav-history-store.js'
import { profileStore } from '../store/profile-store.js'
import { windowState } from '../window-state.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { BrowserWindowState, BrowserTabState } from '../shared/browser.types.js'
import type { BrowserWindow } from 'electron'

/** 脱离所需依赖（windowManager 与 createBrowserWindow 由 main.ts 注入，避免循环引用） */
export interface DetachProfileDeps {
  /** 创建浏览器窗口（多标签） */
  createBrowserWindow: (windowId: string, profileId: string) => BrowserWindow
}

/**
 * 将源窗口中指定标签所属 Profile 的全部标签脱离为独立浏览器窗口。
 *
 * @param sourceWindowId  源窗口 id（通常为 'main'）
 * @param tabId           触发脱离的标签 id（用于确定 Profile 与激活的浏览器标签）
 * @param deps            依赖（createBrowserWindow）
 * @returns 新建的浏览器窗口 id；失败返回 null
 */
export async function detachProfileToBrowserWindow(
  sourceWindowId: string,
  tabId: string,
  deps: DetachProfileDeps,
): Promise<string | null> {
  const { createBrowserWindow } = deps
  const mgr = windowState.windowManager
  if (!mgr) {
    console.warn('[detachProfile] windowManager 未初始化')
    return null
  }

  // 单例防护：该 Profile 已有活跃的浏览器窗口时，直接聚焦它而不重复脱离。
  // 防止 globalShortcut + uiohook 双触发、或用户连续按快捷键时开出多个窗口。
  const existingProfileId = (() => {
    const st = windowStore.getOrDefault(sourceWindowId)
    const tb = st.tabs.find((t) => t.id === tabId)
    return tb?.profileId
  })()
  if (existingProfileId) {
    const existing = windowState.browserWindowsByProfile.get(existingProfileId)
    if (existing && !existing.isDestroyed()) {
      // 已有浏览器窗口 → 聚焦它（而非新开）
      if (existing.isMinimized()) existing.restore()
      if (!existing.isVisible()) existing.show()
      existing.focus()
      return null
    }
  }

  const state = windowStore.getOrDefault(sourceWindowId)
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) {
    console.warn(`[detachProfile] 标签 ${tabId} 不存在于窗口 ${sourceWindowId}`)
    return null
  }

  const profileId = tab.profileId

  // 1. 标记该 Profile 为已脱离（主窗口渲染层将隐藏这些标签）
  //    同时在主窗口 TabState 上记录 detachedWindowId，便于跨窗口归属查询
  const detachedProfiles = state.detachedProfiles ?? []
  if (!detachedProfiles.includes(profileId)) {
    detachedProfiles.push(profileId)
  }
  // 如果当前激活标签属于该 Profile，切换到其他标签
  const newActiveId = state.activeTabId && state.tabs.some((t) => t.id === state.activeTabId && t.profileId === profileId)
    ? (state.tabs.find((t) => t.profileId !== profileId)?.id ?? null)
    : state.activeTabId
  // 为每个脱离的标签标记 detachedWindowId（稍后赋值为 newWindowId）
  const newWindowIdPlaceholder = '__PENDING__'
  const updatedTabs = state.tabs.map((t) =>
    t.profileId === profileId
      ? { ...t, detachedWindowId: newWindowIdPlaceholder }
      : t,
  )
  windowStore.save(sourceWindowId, {
    ...state,
    tabs: updatedTabs,
    detachedProfiles,
    activeTabId: newActiveId,
  })

  // 2. 为浏览器窗口准备 session（仅设置 UA + Client Hints，不创建新 partition）
  await mgr.setupSession(profileId)

  // 3. 查询 Profile 的 AI 平台信息（用于书签来源快照）
  const profile = profileStore.get(profileId)
  const aiPlatformId = profile?.aiPlatformId
  const platformName = profile?.aiPlatformId
    ? (await import('../presets/ai-platforms.js')).AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)?.name
    : undefined

  // 4. 收集该 Profile 的全部标签，转换为 BrowserTabState
  //    保留原 TabState.id 作为 parentTabId（跨窗口归属查询 + 回归时精确恢复）
  const profileTabs = state.tabs.filter((t) => t.profileId === profileId)
  const browserTabs: BrowserTabState[] = profileTabs.map((t, idx) => ({
    id: randomUUID(),
    profileId,
    title: t.title || '',
    url: t.url || '',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    order: idx,
    source: 'initial' as const,
    kind: 'home' as const,
    parentTabId: t.id,
  }))

  if (browserTabs.length === 0) {
    browserTabs.push({
      id: randomUUID(),
      profileId,
      title: tab.title || '',
      url: tab.url || '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      order: 0,
      source: 'initial',
      kind: 'home',
      parentTabId: tab.id,
    })
  }

  // 5. 保存浏览器窗口状态（含 parentTabId / aiPlatformId / platformName 快照）
  const newWindowId = randomUUID()
  const clickedIdx = profileTabs.findIndex((t) => t.id === tabId)
  const activeBrowserTabId = browserTabs[clickedIdx >= 0 ? clickedIdx : browserTabs.length - 1]?.id ?? null

  const browserState: BrowserWindowState = {
    windowId: newWindowId,
    profileId,
    bounds: { width: 0, height: 0 },
    isMaximized: true,
    isFullscreen: false,
    alwaysOnTop: false,
    activeTabId: activeBrowserTabId,
    tabs: browserTabs,
    parentTabId: tab.id,
    aiPlatformId,
    platformName,
  }
  browserWindowStore.save(newWindowId, browserState)

  // 6. 回填主窗口 TabState 的 detachedWindowId（替换占位符为真实 windowId）
  const refreshedState = windowStore.getOrDefault(sourceWindowId)
  const backfilledTabs = refreshedState.tabs.map((t) =>
    t.detachedWindowId === newWindowIdPlaceholder
      ? { ...t, detachedWindowId: newWindowId }
      : t,
  )
  windowStore.save(sourceWindowId, { ...refreshedState, tabs: backfilledTabs })

  // 7. 清除导航历史
  navHistoryStore.clear(profileId)

  // 8. 通知源窗口渲染层隐藏该 Profile 的标签，并同步新的 activeTabId
  const sourceWin = resolveSourceWindow(sourceWindowId)
  if (sourceWin && !sourceWin.isDestroyed()) {
    sourceWin.webContents.send(IPC_CHANNELS.BROWSER_TAB_DETACHED, profileId, newActiveId)
  }

  // 9. 创建浏览器窗口（使用同一个 partition persist:${profileId}）
  createBrowserWindow(newWindowId, profileId)

  return newWindowId
}

/** 根据 windowId 解析源窗口 BrowserWindow 实例（主窗口或脱离窗口） */
function resolveSourceWindow(windowId: string): BrowserWindow | null {
  if (windowId === 'main') return windowState.mainWindow
  return windowState.detachedWindows.get(windowId) ?? null
}
