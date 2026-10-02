import { describe, expect, it } from 'vitest'
import { allowWhiteboardClipboard } from './whiteboard-clipboard'
const url = 'file:///fixture/out/renderer/index.html?windowId=advanced-panel&mode=advanced-panel&tab=whiteboard'
const request = { permission: 'clipboard-sanitized-write', senderId: 3, hostId: 3, hostUrl: url, requestingUrl: url, isMainFrame: true, enabled: true }
describe('whiteboard image permissions', () => {
  it('allows sanitized writes from the registered local host', () => expect(allowWhiteboardClipboard(request)).toBe(true))
  it.each([
    { permission: 'clipboard-read' }, { enabled: false }, { isMainFrame: false }, { senderId: 9 },
    { requestingUrl: 'https://fixture.test/' }, { hostUrl: 'https://fixture.test/?mode=advanced-panel&windowId=advanced-panel' },
    { requestingUrl: 'file:///other/index.html' }, { hostUrl: 'file:///fixture/out/renderer/index.html?mode=main' },
  ])('refuses guests, subframes, unrelated windows and clipboard reads: %j', changes => {
    expect(allowWhiteboardClipboard({ ...request, ...changes })).toBe(false)
  })
})
