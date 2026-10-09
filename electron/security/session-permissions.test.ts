import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'

const state = vi.hoisted(() => ({ profile: vi.fn(), record: vi.fn(), window: vi.fn(), media: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: state.window }, systemPreferences: { getMediaAccessStatus: state.media } }))
vi.mock('../store/profile-repository.js', () => ({ readProfile: state.profile }))
vi.mock('../window-factory/webview-registry.js', () => ({ getRecordByWebContentsId: state.record }))
vi.mock('./trusted-renderer.js', () => ({ isTrustedRendererUrl: (value: string) => value.split('?')[0] === 'file:///E:/app/index.html' }))
import { installApplicationPermissions, installProfilePermissions } from './session-permissions.js'

function fixture() {
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn() }
  const contents = { id: 12, session, isDestroyed: () => false, getType: () => 'webview', getURL: () => 'https://ai.fixture.test/chat' }
  const details = { isMainFrame: true, requestingUrl: contents.getURL() }
  const request = (permission = 'media', overrides = {}, source: unknown = contents) => {
    const callback = vi.fn(); session.setPermissionRequestHandler.mock.calls[0][0](source, permission, callback, { ...details, ...overrides })
    return callback.mock.calls[0][0]
  }
  const check = (permission = 'media', origin = 'https://ai.fixture.test', overrides = {}, source: unknown = contents) =>
    session.setPermissionCheckHandler.mock.calls[0][0](source, permission, origin, { ...details, ...overrides })
  return { session, contents, details, request, check }
}
beforeEach(() => {
  vi.resetAllMocks()
  state.profile.mockReturnValue({ aiPlatformUrl: 'https://ai.fixture.test/chat', browserHomePage: 'https://home.fixture.test/' })
  state.record.mockReturnValue({ profileId: 'profile' }); state.window.mockReturnValue({ isDestroyed: () => false }); state.media.mockReturnValue('granted')
})

describe('profile session permissions', () => {
  it.each(['media', 'geolocation', 'clipboard-read', 'fullscreen'])('allows %s only for its configured main-frame origin', permission => {
    const test = fixture(); installProfilePermissions(test.session as unknown as Session, 'profile')
    expect(test.request(permission)).toBe(true); expect(test.check(permission)).toBe(true)
    expect(test.request(permission, { requestingUrl: 'https://unrelated.test/' })).toBe(false)
    expect(test.check(permission, 'https://unrelated.test')).toBe(false)
    expect(test.request(permission, { isMainFrame: false })).toBe(false)
    expect(test.check(permission, 'https://ai.fixture.test', { requestingUrl: undefined })).toBe(false)
  })

  it('requires the current top-level page, registered profile and exact session', () => {
    const test = fixture(); installProfilePermissions(test.session as unknown as Session, 'profile')
    test.contents.getURL = () => 'https://unrelated.test/'
    expect(test.request('media', { requestingUrl: 'https://unrelated.test/' })).toBe(false)
    test.contents.getURL = () => 'https://ai.fixture.test/chat'
    state.record.mockReturnValue({ profileId: 'other' }); expect(test.request()).toBe(false)
    state.record.mockReturnValue(undefined); expect(test.request()).toBe(false)
    state.record.mockReturnValue({ profileId: 'profile' }); expect(test.request('media', {}, { ...test.contents, session: {} })).toBe(false)
    expect(test.request('media', {}, null)).toBe(false)
    expect(test.request('media', {}, { ...test.contents, isDestroyed: () => true })).toBe(false)
  })

  it('uses current configuration and denies subdomains, credentials and unlisted capabilities', () => {
    const test = fixture(); installProfilePermissions(test.session as unknown as Session, 'profile')
    for (const url of ['https://sub.ai.fixture.test/', 'https://user@ai.fixture.test/', 'http://ai.fixture.test/']) {
      test.contents.getURL = () => url; expect(test.request('media', { requestingUrl: url })).toBe(false)
    }
    test.contents.getURL = () => 'https://home.fixture.test/'
    expect(test.request('media', { requestingUrl: test.contents.getURL() })).toBe(true)
    state.profile.mockReturnValue(undefined); expect(test.request()).toBe(false)
    expect(test.request('usb')).toBe(false); expect(test.session.setDevicePermissionHandler.mock.calls[0][0]({})).toBe(false)
    installProfilePermissions(test.session as unknown as Session, 'profile'); expect(test.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
  })
})

describe('application session permissions', () => {
  it('permits application media and preserves the limited clipboard decision', () => {
    const test = fixture(); test.contents.getType = () => 'window'; test.contents.getURL = () => 'file:///E:/app/index.html?mode=advanced-panel'
    test.details.requestingUrl = test.contents.getURL(); const clipboard = vi.fn(() => true)
    installApplicationPermissions(test.session as unknown as Session, clipboard)
    expect(test.request()).toBe(true); expect(test.check('media', 'file://')).toBe(true)
    expect(clipboard).not.toHaveBeenCalled(); expect(test.request('clipboard-sanitized-write')).toBe(true)
    expect(clipboard).toHaveBeenCalledWith(test.contents, 'clipboard-sanitized-write', test.details)
    expect(test.session.setDevicePermissionHandler.mock.calls[0][0]({})).toBe(false)
  })

  it('denies remote pages, different local documents, guests and unowned windows', () => {
    const test = fixture(); test.contents.getType = () => 'window'; test.contents.getURL = () => 'file:///E:/app/index.html'
    test.details.requestingUrl = test.contents.getURL(); const clipboard = vi.fn(() => true)
    installApplicationPermissions(test.session as unknown as Session, clipboard)
    for (const requestingUrl of ['https://ai.fixture.test/', 'file:///E:/other/index.html', undefined]) expect(test.request('media', { requestingUrl })).toBe(false)
    expect(test.request('media', { isMainFrame: false })).toBe(false)
    expect(test.check('media', 'https://ai.fixture.test')).toBe(false)
    expect(test.request('media', {}, { ...test.contents, getType: () => 'webview' })).toBe(false)
    expect(test.request('media', {}, { ...test.contents, session: {} })).toBe(false)
    state.window.mockReturnValue(null); expect(test.request()).toBe(false)
    expect(clipboard).not.toHaveBeenCalled()
  })
})
