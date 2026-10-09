import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ window: { isDestroyed: () => false }, contents: [] as any[], records: new Map<number, any>(), sessions: new Map<string, any>(), windows: new Map<string, any>() }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: (host: any) => host.window },
  webContents: { fromId: (id: number) => state.contents.find(item => item.id === id), getAllWebContents: () => state.contents },
  session: { fromPartition: (partition: string) => state.sessions.get(partition) } }))
vi.mock('../window-factory/webview-registry.js', () => ({ getRecordByWebContentsId: (id: number) => state.records.get(id) }))
vi.mock('../window-factory/window-utils.js', () => ({ findWindowIdByWin: () => 'window-a' }))
vi.mock('../window-state.js', () => ({ windowState: { browserWindowsByProfile: state.windows } }))
vi.mock('./trusted-renderer.js', () => ({ assertTrustedRenderer: (event: any) => { if (!event.trusted) throw new Error('untrusted') } }))
import { assertOwnedWebview, ownedProfileSession, ownedWebContents } from './webview-owner.js'
let event: any, guest: any
beforeEach(() => {
  state.contents = []; state.records.clear(); state.sessions.clear(); state.windows.clear()
  event = { trusted: true, sender: { window: state.window } }
  guest = { id: 42, getType: () => 'webview', isDestroyed: () => false, hostWebContents: event.sender, session: {} }
  state.contents.push(guest)
  state.sessions.set('persist:profile-a', guest.session)
  state.records.set(42, { windowId: 'window-a', profileId: 'profile-a' })
})
it('resolves only an owned registered guest and its session', () => {
  expect(ownedWebContents(event, 42)).toBe(guest)
  expect(ownedProfileSession(event, 'persist:profile-a')).toBe(guest.session)
  expect(() => ownedProfileSession(event, 'persist:profile-b')).toThrow('不属于')
  expect(() => ownedProfileSession(event, 'profile-a')).toThrow('无效')
  expect(() => ownedWebContents({ ...event, trusted: false }, 42)).toThrow('untrusted')
})
it.each(['host', 'window', 'session', 'type', 'registered', 'destroyed'])('rejects an inconsistent %s binding', reason => {
  if (reason === 'host') guest.hostWebContents = {}
  if (reason === 'window') state.records.get(42).windowId = 'window-b'
  if (reason === 'session') guest.session = {}
  if (reason === 'type') guest.getType = () => 'window'
  if (reason === 'registered') state.records.clear()
  if (reason === 'destroyed') guest.isDestroyed = () => true
  expect(() => assertOwnedWebview(event.sender, guest)).toThrow('不属于')
})
it('permits internal browser tabs to use only the runtime-owned profile', () => {
  state.contents = []
  state.windows.set('profile-a', state.window)
  expect(ownedProfileSession(event, 'persist:profile-a')).toBe(state.sessions.get('persist:profile-a'))
  state.windows.set('profile-a', {})
  expect(() => ownedProfileSession(event, 'persist:profile-a')).toThrow('不属于')
})
