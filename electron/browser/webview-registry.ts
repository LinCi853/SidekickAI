import { webContents, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { targetRegistry } from '../modules/target-registry.js'
import type { WebviewRegistration } from '../shared/api/profile-window.api.js'

export interface WebviewRecord extends WebviewRegistration {
  registeredAt: number
}

const byWebContentsId = new Map<number, WebviewRecord>()
const byTabId = new Map<string, number>()
const destroyedHandlers = new Map<number, () => void>()

export function registerWindowWebview(
  event: IpcMainInvokeEvent,
  payload: WebviewRegistration,
  windowId: string | null,
  profileSession: Session | null,
): boolean {
  if (!payload || typeof payload.tabId !== 'string' || !payload.tabId
    || typeof payload.profileId !== 'string' || !payload.profileId
    || !Number.isSafeInteger(payload.webContentsId) || payload.webContentsId <= 0
    || !windowId || payload.windowId !== windowId || !profileSession
    || event.sender.isDestroyed() || event.sender.getType() !== 'window'
    || event.senderFrame !== event.sender.mainFrame) return false
  const guest = webContents.fromId(payload.webContentsId)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview'
    || guest.hostWebContents !== event.sender || guest.session !== profileSession) return false
  return registerWebview(guest, payload)
}

export function registerWebview(wc: WebContents, info: WebviewRegistration): boolean {
  if (wc.isDestroyed()) return false
  const current = byWebContentsId.get(wc.id)
  if (current?.tabId === info.tabId && current.windowId === info.windowId
    && current.profileId === info.profileId) return true

  const previousId = byTabId.get(info.tabId)
  if (previousId !== undefined && previousId !== wc.id) unregisterWebview(previousId)
  if (current) unregisterWebview(wc.id)
  const record: WebviewRecord = {
    webContentsId: wc.id,
    tabId: info.tabId,
    windowId: info.windowId,
    profileId: info.profileId,
    registeredAt: Date.now(),
  }
  byWebContentsId.set(wc.id, record)
  byTabId.set(info.tabId, wc.id)
  targetRegistry.register({
    targetId: `webview-${wc.id}`,
    type: 'webview',
    nativeId: String(wc.id),
    profileId: info.profileId,
    windowId: info.windowId,
    webContentsId: wc.id,
  })
  const onDestroyed = () => unregisterWebview(wc.id)
  destroyedHandlers.set(wc.id, onDestroyed)
  wc.once('destroyed', onDestroyed)
  return true
}

export function getRecordByWebContentsId(webContentsId: number): WebviewRecord | null {
  return byWebContentsId.get(webContentsId) ?? null
}

export function getRecordByTabId(tabId: string): WebviewRecord | null {
  const wcId = byTabId.get(tabId)
  return wcId === undefined ? null : getRecordByWebContentsId(wcId)
}

export function unregisterWebview(webContentsId: number): void {
  const record = byWebContentsId.get(webContentsId)
  const wc = webContents.fromId(webContentsId)
  const onDestroyed = destroyedHandlers.get(webContentsId)
  if (wc && onDestroyed) wc.removeListener('destroyed', onDestroyed)
  destroyedHandlers.delete(webContentsId)
  byWebContentsId.delete(webContentsId)
  if (record && byTabId.get(record.tabId) === webContentsId) byTabId.delete(record.tabId)
  targetRegistry.unregister(`webview-${webContentsId}`)
}
