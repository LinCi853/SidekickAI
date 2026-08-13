// electron/freeze/webview-registry.ts — guest webContents 注册表
//
// 维护 webContentsId ↔ { tabId, windowId, profileId } 映射，供冻结管理器按 tabId
// 查找目标 webContents。在 did-attach-webview 回调中注册，webContents 销毁时清理。
//
// 设计：主进程原本无 tabId ↔ webContentsId 映射（弹窗转发靠渲染层上报 webContentsId）。
// 冻结功能需要按 tabId 精确定位 guest webContents，故新建此注册表。

import { webContents, type WebContents } from 'electron'

type DestroyHandler = (record: WebviewRecord) => void
let destroyHandler: DestroyHandler | null = null

/** 注册 guest 销毁通知，供冻结管理器清理绑定到旧 webContents 的会话。 */
export function setWebviewDestroyedHandler(handler: DestroyHandler): void {
  destroyHandler = handler
}

export interface WebviewRecord {
  /** guest webContents id（与渲染层 getWebContentsId() 一致） */
  webContentsId: number
  /** 标签 id（主窗口 TabState.id 或浏览器窗口 BrowserTabState.id） */
  tabId: string
  /** 所属窗口 id（'main' 或浏览器窗口 UUID） */
  windowId: string
  /** 关联 Profile id */
  profileId: string
  /** 注册时间戳 */
  registeredAt: number
}

/** webContentsId → WebviewRecord */
const byWebContentsId = new Map<number, WebviewRecord>()
/** tabId → webContentsId（一个 tab 一个 webview） */
const byTabId = new Map<string, number>()
/** webContentsId → 唯一 destroyed 监听器，避免 dom-ready 重复注册累积监听器 */
const destroyedHandlers = new Map<number, () => void>()

/**
 * 注册一个 guest webContents。
 * 在 did-attach-webview 回调中调用：渲染层需先通过 IPC 上报 { tabId, windowId, profileId }，
 * 或主进程在 attach 时已知这些信息。
 */
export function registerWebview(
  wc: WebContents,
  info: { tabId: string; windowId: string; profileId: string },
): void {
  const previousId = byTabId.get(info.tabId)
  if (previousId !== undefined && previousId !== wc.id) {
    const previous = byWebContentsId.get(previousId)
    const previousWc = webContents.fromId(previousId)
    const previousHandler = destroyedHandlers.get(previousId)
    if (previousWc && previousHandler) previousWc.removeListener('destroyed', previousHandler)
    destroyedHandlers.delete(previousId)
    byWebContentsId.delete(previousId)
    if (previous) destroyHandler?.(previous)
  }
  const record: WebviewRecord = {
    webContentsId: wc.id,
    tabId: info.tabId,
    windowId: info.windowId,
    profileId: info.profileId,
    registeredAt: Date.now(),
  }
  byWebContentsId.set(wc.id, record)
  byTabId.set(info.tabId, wc.id)

  if (!destroyedHandlers.has(wc.id)) {
    const onDestroyed = () => {
      const rec = byWebContentsId.get(wc.id)
      byWebContentsId.delete(wc.id)
      destroyedHandlers.delete(wc.id)
      if (rec && byTabId.get(rec.tabId) === wc.id) byTabId.delete(rec.tabId)
      if (rec) destroyHandler?.(rec)
    }
    destroyedHandlers.set(wc.id, onDestroyed)
    wc.once('destroyed', onDestroyed)
  }
}

/** 按 tabId 查找 guest webContents 实例（可能已销毁，返回 null） */
export function getWebviewByTabId(tabId: string): WebContents | null {
  const wcId = byTabId.get(tabId)
  if (wcId === undefined) return null
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return null
  return wc
}

/** 按 webContentsId 查找记录 */
export function getRecordByWebContentsId(webContentsId: number): WebviewRecord | null {
  return byWebContentsId.get(webContentsId) ?? null
}

/** 按 tabId 查找记录 */
export function getRecordByTabId(tabId: string): WebviewRecord | null {
  const wcId = byTabId.get(tabId)
  if (wcId === undefined) return null
  return byWebContentsId.get(wcId) ?? null
}

/** 注销（一般由 destroyed 事件自动触发，手动调用兜底） */
export function unregisterWebview(webContentsId: number): void {
  const rec = byWebContentsId.get(webContentsId)
  const wc = webContents.fromId(webContentsId)
  const onDestroyed = destroyedHandlers.get(webContentsId)
  if (wc && onDestroyed) wc.removeListener('destroyed', onDestroyed)
  destroyedHandlers.delete(webContentsId)
  byWebContentsId.delete(webContentsId)
  if (rec && byTabId.get(rec.tabId) === webContentsId) byTabId.delete(rec.tabId)
  if (rec) destroyHandler?.(rec)
}

/** 调试用：列出全部已注册 webview */
export function listRegisteredWebviews(): WebviewRecord[] {
  return Array.from(byWebContentsId.values())
}
