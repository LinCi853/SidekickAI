import { BrowserWindow, session, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { getRecordByWebContentsId } from '../window-factory/webview-registry.js'
import { findWindowIdByWin } from '../window-factory/window-utils.js'
import { windowState } from '../window-state.js'
import { assertTrustedRenderer } from './trusted-renderer.js'

export function assertOwnedWebview(host: WebContents, guest: WebContents): void {
  const window = BrowserWindow.fromWebContents(host)
  const record = getRecordByWebContentsId(guest.id)
  if (!window || window.isDestroyed() || guest.isDestroyed() || guest.getType() !== 'webview'
    || guest.hostWebContents !== host || !record || record.windowId !== findWindowIdByWin(window)
    || guest.session !== session.fromPartition(`persist:${record.profileId}`)) {
    throw new Error('网页不属于当前应用窗口。')
  }
}

export function ownedWebContents(event: IpcMainInvokeEvent, id: unknown): WebContents {
  assertTrustedRenderer(event)
  const guest = Number.isSafeInteger(id) ? webContents.fromId(id as number) : undefined
  if (!guest) throw new Error('网页已关闭。')
  assertOwnedWebview(event.sender, guest)
  return guest
}

export function ownedProfileSession(event: IpcMainInvokeEvent, partition: unknown): Electron.Session {
  assertTrustedRenderer(event)
  if (typeof partition !== 'string' || !partition.startsWith('persist:') || partition.length > 160) throw new Error('网页会话无效。')
  const profileId = partition.slice(8)
  const window = BrowserWindow.fromWebContents(event.sender)
  if (windowState.browserWindowsByProfile.get(profileId) === window) return session.fromPartition(partition)
  for (const guest of webContents.getAllWebContents()) {
    if (guest.isDestroyed() || guest.hostWebContents !== event.sender || getRecordByWebContentsId(guest.id)?.profileId !== profileId) continue
    assertOwnedWebview(event.sender, guest)
    return guest.session
  }
  throw new Error('网页会话不属于当前窗口。')
}
