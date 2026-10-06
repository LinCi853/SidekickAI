import { BrowserWindow, webContents, type WebContents } from 'electron'
import type { WebviewHotkeyTarget } from '../shared/api/settings.api.js'
import { getRecordByWebContentsId } from '../freeze/webview-registry.js'
import { findWindowIdByWin } from './window-utils.js'

interface GuestState {
  host: WebContents
  generation: number
  navigating: boolean
}

const guests = new WeakMap<WebContents, GuestState>()

export function trackWebviewHotkeyTarget(guest: WebContents, host: WebContents): void {
  if (guests.has(guest)) return
  const state: GuestState = { host, generation: 0, navigating: false }
  guests.set(guest, state)
  guest.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame) return
    state.generation += 1
    state.navigating = !inPlace
  })
  guest.on('did-navigate-in-page', (_event, _url, mainFrame) => {
    if (mainFrame) state.generation += 1
  })
  guest.on('dom-ready', () => { state.navigating = false })
  guest.on('render-process-gone', () => {
    state.generation += 1
    state.navigating = true
  })
  guest.once('destroyed', () => { guests.delete(guest) })
}

export function captureWebviewHotkeyTarget(guest: WebContents, host: WebContents): WebviewHotkeyTarget | null {
  const state = guests.get(guest)
  if (!state || state.host !== host || state.navigating || guest.isDestroyed() || host.isDestroyed()) return null
  const win = BrowserWindow.fromWebContents(host)
  if (!win || win.isDestroyed() || !win.isFocused() || !guest.isFocused()) return null
  const record = getRecordByWebContentsId(guest.id)
  const windowId = findWindowIdByWin(win)
  if (record && record.windowId !== windowId) return null
  return {
    webContentsId: guest.id,
    documentGeneration: state.generation,
    url: guest.getURL(),
    ...(record ? { tabId: record.tabId, profileId: record.profileId, windowId: record.windowId } : {}),
  }
}

export function validateWebviewHotkeyTarget(host: WebContents, target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const expected = target as WebviewHotkeyTarget
  if (!Number.isSafeInteger(expected.webContentsId) || !Number.isSafeInteger(expected.documentGeneration)) return false
  const guest = webContents.fromId(expected.webContentsId)
  if (!guest) return false
  const current = captureWebviewHotkeyTarget(guest, host)
  return !!current && current.documentGeneration === expected.documentGeneration && current.url === expected.url
    && current.tabId === expected.tabId && current.profileId === expected.profileId && current.windowId === expected.windowId
}
