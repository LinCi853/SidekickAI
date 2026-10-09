import { BrowserWindow, systemPreferences, type Session, type WebContents } from 'electron'
import { readProfile } from '../store/profile-repository.js'
import { getRecordByWebContentsId } from '../window-factory/webview-registry.js'
import { isTrustedRendererUrl } from './trusted-renderer.js'

const configuredSessions = new WeakSet<Session>()
const profilePermissions = new Set(['media', 'geolocation', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'speaker-selection'])
interface RequestDetails { requestingUrl?: string; isMainFrame: boolean }

function webOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch { return null }
}

function sameOrigin(value: string, documentUrl: string): boolean {
  try {
    const origin = new URL(value), document = new URL(documentUrl)
    return !origin.username && !origin.password && origin.protocol === document.protocol && origin.host === document.host
  } catch { return false }
}

export function installProfilePermissions(session: Session, profileId: string): void {
  if (configuredSessions.has(session)) return
  configuredSessions.add(session)
  const allowed = (contents: WebContents | null, permission: string, details: RequestDetails, requestingOrigin?: string) => {
    if (!contents || contents.isDestroyed() || contents.session !== session || !details.isMainFrame || !profilePermissions.has(permission)) return false
    const record = getRecordByWebContentsId(contents.id)
    if (record && record.profileId !== profileId || contents.getType() === 'webview' && !record) return false
    const profile = readProfile(profileId)
    if (!profile) return false
    const expected = [profile.aiPlatformUrl, profile.browserHomePage].map(webOrigin).filter(Boolean)
    const current = webOrigin(contents.getURL()), requester = webOrigin(details.requestingUrl)
    return Boolean(current && requester === current && expected.includes(current) && (!requestingOrigin || webOrigin(requestingOrigin) === current))
  }
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details)))
  session.setPermissionCheckHandler((contents, permission, origin, details) => allowed(contents, permission, details, origin))
  session.setDevicePermissionHandler(() => false)
}

export function installApplicationPermissions(session: Session, clipboardAllowed: (contents: WebContents, permission: string, details: RequestDetails) => boolean): void {
  const allowed = (contents: WebContents | null, permission: string, details: RequestDetails, mediaTypes: string[]) => {
    if (!contents || contents.isDestroyed() || contents.session !== session || contents.getType() !== 'window' || !details.isMainFrame
      || !isTrustedRendererUrl(contents.getURL()) || !isTrustedRendererUrl(details.requestingUrl ?? '')) return false
    const window = BrowserWindow.fromWebContents(contents)
    if (!window || window.isDestroyed()) return false
    if (permission === 'media') {
      if (process.platform !== 'darwin') return true
      try { return mediaTypes.every(type => systemPreferences.getMediaAccessStatus(type === 'video' ? 'camera' : 'microphone') === 'granted') }
      catch { return false }
    }
    return clipboardAllowed(contents, permission, details)
  }
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed(contents, permission, details, ('mediaTypes' in details ? details.mediaTypes : undefined) ?? ['audio']))
  })
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    return Boolean(contents && sameOrigin(origin, contents.getURL()) && allowed(contents, permission, details, [details.mediaType ?? 'audio']))
  })
  session.setDevicePermissionHandler(() => false)
}
