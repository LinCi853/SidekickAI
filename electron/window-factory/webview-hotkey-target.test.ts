import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => ({ contents: new Map<number, unknown>(), record: null as null | { windowId: string; tabId: string; profileId: string } }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (host: { win: unknown }) => host.win },
  webContents: { fromId: (id: number) => lookup.contents.get(id) },
}))
vi.mock('../freeze/webview-registry.js', () => ({ getRecordByWebContentsId: () => lookup.record }))
vi.mock('./window-utils.js', () => ({ findWindowIdByWin: () => 'main' }))
import { captureWebviewHotkeyTarget, trackWebviewHotkeyTarget, validateWebviewHotkeyTarget } from './webview-hotkey-target.js'

function page() {
  const guest = Object.assign(new EventEmitter(), {
    id: 41, destroyed: false, focused: true, url: 'https://example.com/chat',
    isDestroyed() { return this.destroyed },
    isFocused() { return this.focused },
    getURL() { return this.url },
  })
  const host = { id: 12, isDestroyed: () => false, win: { isDestroyed: () => false, isFocused: () => true } }
  lookup.contents.set(guest.id, guest)
  trackWebviewHotkeyTarget(guest as never, host as never)
  return { guest, host }
}

describe('Guest hotkey identity', () => {
  beforeEach(() => { lookup.contents.clear(); lookup.record = null })

  it('rejects a late action after reload even when guest and URL are unchanged', () => {
    const { guest, host } = page()
    const target = captureWebviewHotkeyTarget(guest as never, host as never)!
    expect(validateWebviewHotkeyTarget(host as never, target)).toBe(true)
    guest.emit('did-start-navigation', {}, guest.url, false, true)
    expect(captureWebviewHotkeyTarget(guest as never, host as never)).toBeNull()
    guest.emit('dom-ready')
    expect(validateWebviewHotkeyTarget(host as never, target)).toBe(false)
    expect(captureWebviewHotkeyTarget(guest as never, host as never)?.documentGeneration).toBe(1)
  })

  it('rejects another host, an inactive guest, and an ownership change', () => {
    const { guest, host } = page()
    const target = captureWebviewHotkeyTarget(guest as never, host as never)!
    expect(validateWebviewHotkeyTarget({ ...host } as never, target)).toBe(false)
    guest.focused = false
    expect(validateWebviewHotkeyTarget(host as never, target)).toBe(false)
    guest.focused = true
    lookup.record = { windowId: 'retired', tabId: 'tab', profileId: 'profile' }
    expect(captureWebviewHotkeyTarget(guest as never, host as never)).toBeNull()
  })

  it('tracks one lifecycle per guest and invalidates SPA navigation or renderer failure', () => {
    const { guest, host } = page()
    trackWebviewHotkeyTarget(guest as never, host as never)
    expect(guest.listenerCount('did-start-navigation')).toBe(1)
    const target = captureWebviewHotkeyTarget(guest as never, host as never)!
    guest.emit('did-navigate-in-page', {}, guest.url, true)
    expect(validateWebviewHotkeyTarget(host as never, target)).toBe(false)
    guest.emit('render-process-gone')
    expect(captureWebviewHotkeyTarget(guest as never, host as never)).toBeNull()
    guest.emit('destroyed')
    expect(captureWebviewHotkeyTarget(guest as never, host as never)).toBeNull()
  })
})
