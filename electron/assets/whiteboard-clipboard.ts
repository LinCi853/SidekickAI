export interface WhiteboardClipboardRequest {
  permission: string
  senderId?: number
  hostId?: number
  hostUrl: string
  requestingUrl: string
  isMainFrame: boolean
  enabled: boolean
}

/** Only the trusted local whiteboard host can request sanitized image writes. */
export function allowWhiteboardClipboard(request: WhiteboardClipboardRequest): boolean {
  if (request.permission !== 'clipboard-sanitized-write' || !request.enabled || !request.isMainFrame
    || request.senderId === undefined || request.senderId !== request.hostId) return false
  try {
    const host = new URL(request.hostUrl)
    const requester = new URL(request.requestingUrl)
    return host.protocol === 'file:' && requester.protocol === 'file:' && host.pathname === requester.pathname
      && host.searchParams.get('mode') === 'advanced-panel'
      && host.searchParams.get('windowId') === 'advanced-panel'
  } catch { return false }
}
