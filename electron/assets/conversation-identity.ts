/** A web conversation stays stable across transient query and fragment changes. */
export function canonicalWebConversationUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    return url.origin + (url.pathname.replace(/\/+$/, '') || '/')
  } catch { return undefined }
}
