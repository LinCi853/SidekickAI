export const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'self' blob: sidekick-pdf:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://esm.sh; img-src 'self' data: blob: https: whiteboard-asset: notes-asset:; media-src 'self' data: blob:; connect-src 'self' data: https://esm.sh whiteboard-asset: notes-asset:"

/** @param {string[]} developmentUrls */
export function rendererContentSecurityPolicy(developmentUrls = []) {
  const websocketOrigins = new Set()
  for (const value of developmentUrls) {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      websocketOrigins.add(url.origin)
    } catch { /* Invalid development addresses add no network authority. */ }
  }
  return RENDERER_CONTENT_SECURITY_POLICY + (websocketOrigins.size ? ` ${[...websocketOrigins].join(' ')}` : '')
}
