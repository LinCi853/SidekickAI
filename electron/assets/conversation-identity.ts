/** A web conversation stays stable across transient query and fragment changes. */
export function canonicalWebConversationUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    if (url.hostname === 'aistudio.xiaomimimo.com') {
      const route = url.hash.split('?')[0].replace(/\/+$/, '')
      if (/^#\/(?:chat|ultra)\/[^/]+$/.test(route)) return url.origin + (url.pathname.replace(/\/+$/, '') || '/') + route
    }
    if (['chatglm.cn', 'www.chatglm.cn'].includes(url.hostname) && url.pathname.startsWith('/main/')) {
      const conversation = url.searchParams.get('cid')
      if (conversation) return url.origin + url.pathname.replace(/\/+$/, '') + '?cid=' + encodeURIComponent(conversation)
    }
    return url.origin + (url.pathname.replace(/\/+$/, '') || '/')
  } catch { return undefined }
}

export function stableWebConversationUrl(value: string): string | undefined {
  const canonical = canonicalWebConversationUrl(value)
  if (!canonical) return undefined
  const url = new URL(canonical)
  if (['chatglm.cn', 'www.chatglm.cn'].includes(url.hostname) && url.pathname.startsWith('/main/') && !url.searchParams.get('cid')) return undefined
  return url.hash || !['/', '/chat', '/app', '/c', '/ultra'].includes(url.pathname) ? canonical : undefined
}
