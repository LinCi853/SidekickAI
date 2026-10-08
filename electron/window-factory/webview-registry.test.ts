import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewRegistration } from '../shared/api/profile-window.api.js'

const fixture = vi.hoisted(() => ({
  guests: new Map<number, WebContents>(),
  sessions: new Map<string, object>(),
  register: vi.fn(),
  unregister: vi.fn(),
}))
vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => fixture.guests.get(id) },
}))
vi.mock('../modules/target-registry.js', () => ({ targetRegistry: { register: fixture.register, unregister: fixture.unregister } }))

let registry: typeof import('./webview-registry')

function guest(id: number, host: WebContents) {
  const state = { destroyed: false }
  const contents = Object.assign(new EventEmitter(), {
    id,
    hostWebContents: host,
    session: fixture.sessions.get('persist:profile-a'),
    getType: () => 'webview',
    isDestroyed: () => state.destroyed,
  })
  fixture.guests.set(id, contents as unknown as WebContents)
  return { contents, state }
}

function request() {
  const mainFrame = {}
  const host = { mainFrame, getType: () => 'window', isDestroyed: () => false } as unknown as WebContents
  const view = guest(12, host)
  const event = { sender: host, senderFrame: mainFrame } as IpcMainInvokeEvent
  const payload: WebviewRegistration = { tabId: 'tab-a', profileId: 'profile-a', windowId: 'main', webContentsId: 12 }
  return { host, event, payload, ...view }
}

function register(value: ReturnType<typeof request>, windowId: string | null = 'main') {
  const profileSession = fixture.sessions.get(`persist:${value.payload?.profileId}`) as Session | undefined
  return registry.registerWindowWebview(value.event, value.payload, windowId, profileSession ?? null)
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.guests.clear()
  fixture.sessions.clear()
  fixture.sessions.set('persist:profile-a', {})
  fixture.sessions.set('persist:profile-b', {})
  registry = await import('./webview-registry')
})

describe('window guest identity', () => {
  it('registers the owned profile guest and shares its target identity', () => {
    const value = request()
    expect(register(value)).toBe(true)
    expect(registry.getRecordByWebContentsId(12)).toMatchObject(value.payload)
    expect(registry.getRecordByTabId('tab-a')).toMatchObject(value.payload)
    expect(fixture.register).toHaveBeenCalledWith({ targetId: 'webview-12', type: 'webview', nativeId: '12',
      profileId: 'profile-a', windowId: 'main', webContentsId: 12 })
  })

  it('does not retire the shared target or add listeners on repeated page readiness', () => {
    const value = request()
    expect(register(value)).toBe(true)
    expect(register(value)).toBe(true)
    expect(value.contents.listenerCount('destroyed')).toBe(1)
    expect(fixture.register).toHaveBeenCalledOnce()
    expect(fixture.unregister).not.toHaveBeenCalled()
  })

  it('replaces a retired guest without letting its later destruction remove the new tab', () => {
    const value = request()
    register(value)
    const replacement = guest(13, value.host)
    const payload = { ...value.payload, webContentsId: 13 }
    expect(register({ ...value, payload })).toBe(true)
    value.contents.emit('destroyed')
    expect(registry.getRecordByWebContentsId(12)).toBeNull()
    expect(registry.getRecordByTabId('tab-a')).toMatchObject(payload)
    expect(value.contents.listenerCount('destroyed')).toBe(0)
    expect(replacement.contents.listenerCount('destroyed')).toBe(1)
    expect(fixture.unregister).toHaveBeenCalledWith('webview-12')
  })

  it('clears the former tab mapping when a guest is assigned to another tab', () => {
    const value = request()
    register(value)
    const payload = { ...value.payload, tabId: 'tab-b' }
    expect(register({ ...value, payload })).toBe(true)
    expect(registry.getRecordByTabId('tab-a')).toBeNull()
    expect(registry.getRecordByTabId('tab-b')).toMatchObject(payload)
    expect(value.contents.listenerCount('destroyed')).toBe(1)
  })

  it('cleans both mappings and the shared target when the current guest is destroyed', () => {
    const value = request()
    register(value)
    value.state.destroyed = true
    value.contents.emit('destroyed')
    expect(registry.getRecordByWebContentsId(12)).toBeNull()
    expect(registry.getRecordByTabId('tab-a')).toBeNull()
    expect(fixture.unregister).toHaveBeenCalledWith('webview-12')
  })

  it.each(['unknown-window', 'wrong-window', 'subframe', 'guest-sender', 'wrong-host', 'wrong-profile',
    'unknown-profile', 'missing-guest', 'destroyed-guest', 'destroyed-host', 'window-target'] as const)
  ('rejects %s registration without changing targets', reason => {
    const value = request()
    let windowId: string | null = 'main'
    if (reason === 'unknown-window') windowId = null
    else if (reason === 'wrong-window') windowId = 'other-window'
    else if (reason === 'subframe') Object.assign(value.event, { senderFrame: {} })
    else if (reason === 'guest-sender') Object.assign(value.host, { getType: () => 'webview' })
    else if (reason === 'wrong-host') Object.assign(value.contents, { hostWebContents: {} })
    else if (reason === 'wrong-profile') value.payload.profileId = 'profile-b'
    else if (reason === 'unknown-profile') value.payload.profileId = 'missing-profile'
    else if (reason === 'missing-guest') fixture.guests.delete(12)
    else if (reason === 'destroyed-guest') value.state.destroyed = true
    else if (reason === 'destroyed-host') Object.assign(value.host, { isDestroyed: () => true })
    else if (reason === 'window-target') Object.assign(value.contents, { getType: () => 'window' })
    expect(register(value, windowId)).toBe(false)
    expect(registry.getRecordByTabId('tab-a')).toBeNull()
    expect(fixture.register).not.toHaveBeenCalled()
    expect(fixture.unregister).not.toHaveBeenCalled()
  })

  it.each([null, {}, { tabId: '' }, { profileId: '' }, { webContentsId: 0 }, { webContentsId: 12.5 },
    { webContentsId: '12' }])('rejects incomplete identity %j', changes => {
    const value = request()
    const payload = changes === null ? null : { ...value.payload, ...changes }
    if (changes && !Object.keys(changes).length) delete (payload as Partial<WebviewRegistration>).tabId
    expect(register({ ...value, payload: payload as WebviewRegistration })).toBe(false)
    expect(fixture.register).not.toHaveBeenCalled()
  })
})
