import { app, BrowserWindow, net } from 'electron'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { getChatStore } from '../store/chat-store.js'
import type { AssetAttachment } from '../shared/ai-assets.types.js'
import { OriginalVault } from './original-vault.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { isModuleEnabled } from '../modules/registry.js'

const active = new Set<string>()
const controllers = new Map<string, AbortController>()
export function hasLinkedOriginalTransfers(): boolean { return active.size > 0 }
export function stopLinkedOriginalTransfers(): void {
  for (const controller of controllers.values()) controller.abort()
}
export async function acquireLinkedOriginal(item: AssetAttachment, fetcher: typeof net.fetch = net.fetch): Promise<void> {
  if (active.has(item.id)) return
  active.add(item.id)
  const controller = new AbortController()
  controllers.set(item.id, controller)
  const vault = new OriginalVault(path.join(app.getPath('userData'), 'ai-assets'), path.join(app.getPath('userData'), '.ai-assets-pending'))
  const store = () => getChatStore().assets
  try {
    if (item.sha256) {
      let verifiedSize: number | undefined
      try { const file = await vault.verify(item.sha256, item.size); verifiedSize = item.size ?? (await stat(file)).size } catch {}
      controller.signal.throwIfAborted()
      if (verifiedSize !== undefined) { store().attachmentSaved(item.id, item.sha256, verifiedSize, true); return }
    }
    if (!/^https?:\/\//.test(item.sourceUrl ?? '')) throw new Error('临时资料已失效，请重新上传或打开原资料')
    store().attachmentPending(item.id)
    await vault.begin(item.id)
    const response = await fetcher(item.sourceUrl!, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) })
    if (!response.ok || !response.body) throw new Error(`原件获取失败：HTTP ${response.status}`)
    let offset = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        controller.signal.throwIfAborted()
        if (chunk.done) break
        await vault.append(item.id, offset, chunk.value); offset += chunk.value.byteLength
      }
    } finally { reader.releaseLock() }
    const original = await vault.finish(item.id, offset, item.sha256)
    controller.signal.throwIfAborted()
    store().attachmentSaved(item.id, original.sha256, original.size, original.reused)
  } catch (error) {
    await vault.abort(item.id)
    store().attachmentFailed(item.id, String(error))
  } finally {
    active.delete(item.id)
    controllers.delete(item.id)
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, { sourceId: item.sourceId })
  }
}

export async function collectApiOriginals(sourceId: string, conversationId: string, messageId: string, content: string): Promise<void> {
  for (const match of content.matchAll(/(!?)\[[^\]]*\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    if (!isModuleEnabled('prompt-library')) return
    let url: URL
    try { url = new URL(match[2]) } catch { continue }
    let name = url.pathname.split('/').pop() || '资料'
    try { name = decodeURIComponent(name) } catch {}
    if (!match[1] && !/\.(?:pdf|zip|txt|csv|json|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|mp3|wav|mp4)(?:$|\?)/i.test(url.pathname)) continue
    const store = getChatStore().assets
    const reference = store.beginAttachment({ id: sourceId, type: 'api' }, {
      conversationKey: `api:${conversationId}`, title: '', messageKey: messageId,
      externalKey: `${messageId}:${createHash('sha256').update(url.href).digest('hex')}`,
      name, mimeType: match[1] ? 'image/*' : 'application/octet-stream',
      sourceUrl: url.href, direction: 'output',
    }, conversationId)
    await acquireLinkedOriginal(reference)
  }
}
