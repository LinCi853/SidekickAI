import { app, type Session } from 'electron'
import { rendererContentSecurityPolicy } from '../shared/renderer-csp.mjs'
import { isTrustedRendererUrl } from './trusted-renderer.js'

export function installRendererContentSecurity(session: Session): void {
  const policy = rendererContentSecurityPolicy(!app.isPackaged && process.env.ELECTRON_RENDERER_URL ? [process.env.ELECTRON_RENDERER_URL] : [])
    + "; frame-ancestors 'none'"
  session.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url)) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'))
    callback({ responseHeaders: { ...headers, 'Content-Security-Policy': [policy] } })
  })
}
