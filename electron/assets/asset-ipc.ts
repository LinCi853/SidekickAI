import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, webContents, type IpcMainInvokeEvent } from 'electron'
import { copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getChatStore } from '../store/chat-store.js'
import { profileStore } from '../store/profile-store.js'
import { isModuleEnabled, observeModuleState } from '../modules/registry.js'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AssetAttachmentInput, AssetCollectionIssue, AssetObservation } from '../shared/ai-assets.types.js'
import { OriginalVault } from './original-vault.js'
import { acquireLinkedOriginal, stopLinkedOriginalTransfers } from './api-originals.js'
import { getRecordByWebContentsId } from '../freeze/webview-registry.js'
import { getAssetSettings, updateAssetSettings } from './settings.js'
import { previewAssetCode } from './code-preview.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'

let stopTransfers: (() => void) | undefined
let transfersActive: () => boolean = () => false
export function hasWebOriginalTransfers(): boolean { return transfersActive() }

export function broadcastAiAssetState(): void {
  if (!isModuleEnabled('prompt-library')) { stopTransfers?.(); stopLinkedOriginalTransfers() }
  for (const guest of webContents.getAllWebContents()) {
    if (!guest.isDestroyed()) guest.send(ipc.ASSET_COLLECTOR_STATE, isModuleEnabled('prompt-library'))
  }
}

export function registerAiAssetIpc(): void {
  const collectionIssues = new Map<number, AssetCollectionIssue>()
  const publishCollectionIssues = () => {
    const issues = [...collectionIssues.values()]
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed())
      window.webContents.send(ipc.ASSET_COLLECTION_ISSUES_CHANGED, issues)
  }
  let assetEnabled = false
  const syncCollection = () => {
    const enabled = isModuleEnabled('prompt-library')
    if (enabled && !assetEnabled) getChatStore().cleanupInvalidConversations()
    if (!enabled && collectionIssues.size) { collectionIssues.clear(); publishCollectionIssues() }
    assetEnabled = enabled
    broadcastAiAssetState()
  }
  observeModuleState(syncCollection)
  syncCollection()
  const vault = new OriginalVault(path.join(app.getPath('userData'), 'ai-assets'), path.join(app.getPath('userData'), '.ai-assets-pending'))
  const owners = new Map<string, number>()
  const controllers = new Map<string, AbortController>()
  transfersActive = () => owners.size > 0
  const abortTransfer = (id: string) => {
    const controller = controllers.get(id)
    controller?.abort()
    void vault.abort(id).finally(() => {
      if (controllers.get(id) === controller) { owners.delete(id); controllers.delete(id) }
    })
  }
  stopTransfers = () => {
    for (const id of owners.keys()) {
      abortTransfer(id)
      getChatStore().assets.attachmentFailed(id, 'AI资产已关闭，原件传输未完成')
    }
  }
  const guests = new Set<number>()
  const registerGuest = (event: IpcMainInvokeEvent) => {
    if (guests.has(event.sender.id)) return
    guests.add(event.sender.id)
    const guestId = event.sender.id
    event.sender.once('destroyed', () => {
      guests.delete(guestId)
      if (collectionIssues.delete(guestId)) publishCollectionIssues()
      for (const [id, owner] of owners) if (owner === guestId) {
        abortTransfer(id)
        try { getChatStore().assets.attachmentFailed(id, '页面已关闭，原件传输未完成') } catch {}
      }
    })
  }
  const broadcast = (sourceId: string) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(ipc.CHAT_CONVERSATION_PERSISTED, { sourceId })
    }
  }
  const source = (event: IpcMainInvokeEvent) => {
    const profile = profileStore.list().find(p => p.isAIPlatform && session.fromPartition(`persist:${p.id}`) === event.sender.session)
    if (!profile || event.senderFrame !== event.sender.mainFrame) throw new Error('AI asset source is not authorized')
    registerGuest(event)
    if (!isModuleEnabled('prompt-library')) throw new Error('AI assets are disabled')
    return { id: profile.id, type: 'webview' as const, name: profile.name }
  }
  const own = (event: IpcMainInvokeEvent, id: string) => {
    const profile = source(event)
    if (owners.get(id) !== event.sender.id || getChatStore().assets.getAttachment(id)?.sourceId !== profile.id)
      throw new Error('Original transfer does not belong to this source')
    return profile
  }
  const local = (event: IpcMainInvokeEvent) => {
    const url = event.sender.getURL()
    const development = process.env.ELECTRON_RENDERER_URL
    if (event.senderFrame !== event.sender.mainFrame || event.sender.getType() !== 'window' || (!url.startsWith('file:') && (!development || new URL(url).origin !== new URL(development).origin)))
      throw new Error('AI asset viewer is not authorized')
  }
  ipcMain.handle(ipc.ASSET_AUTHORIZE, event => { try { source(event); return true } catch { return false } })
  ipcMain.handle(ipc.ASSET_OBSERVE, (event, observation: AssetObservation) => {
    const profile = source(event)
    if (!observation || typeof observation.conversationKey !== 'string' || !Array.isArray(observation.messages))
      throw new Error('Invalid AI asset observation')
    for (const message of observation.messages) {
      if (typeof message.key !== 'string' || typeof message.content !== 'string'
        || !['user', 'assistant', 'system'].includes(message.role)
        || (message.reasoning !== undefined && typeof message.reasoning !== 'string')) throw new Error('Invalid AI asset message')
    }
    if (observation.messages.length > 10000 || (observation.visitId !== undefined && typeof observation.visitId !== 'string')
      || (observation.adapter !== undefined && typeof observation.adapter !== 'string')
      || (observation.rejected !== undefined && (!Array.isArray(observation.rejected) || observation.rejected.length > 1000))) throw new Error('Invalid asset snapshot')
    for (const message of observation.messages) {
      if ((message.markdownContent !== undefined && typeof message.markdownContent !== 'string')
        || (message.versionKey !== undefined && typeof message.versionKey !== 'string')
        || (message.branchIndex !== undefined && (!Number.isSafeInteger(message.branchIndex) || message.branchIndex < 1))
        || (message.branchCount !== undefined && (!Number.isSafeInteger(message.branchCount) || message.branchCount < 1))) throw new Error('Invalid asset branch')
    }
    for (const item of observation.rejected ?? []) if (typeof item.key !== 'string' || typeof item.reason !== 'string' || !/^[a-f0-9]{64}$/.test(item.signature)) throw new Error('Invalid rejection record')
    let result: { conversationId: string; suppressed?: boolean; messageIds?: Record<string, string> }
    try { result = getChatStore().assets.observe(profile, observation) }
    catch (error) {
      collectionIssues.set(event.sender.id, { webContentsId: event.sender.id, profileId: profile.id, profileName: profile.name,
        failures: (collectionIssues.get(event.sender.id)?.failures ?? 0) + 1, updatedAt: Date.now() })
      publishCollectionIssues()
      throw error
    }
    if (collectionIssues.delete(event.sender.id)) publishCollectionIssues()
    broadcast(profile.id)
    return result
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_BEGIN, async (event, input: AssetAttachmentInput) => {
    const profile = source(event)
    if (!input || typeof input.name !== 'string' || typeof input.externalKey !== 'string'
      || typeof input.conversationKey !== 'string' || !['input', 'output'].includes(input.direction)
      || (input.messageId !== undefined && (typeof input.messageId !== 'string' || typeof input.messageKey !== 'string'))) throw new Error('Invalid original metadata')
    const reference = getChatStore().assets.beginAttachment(profile, input)
    if (owners.has(reference.id)) return { id: reference.id, busy: true }
    owners.set(reference.id, event.sender.id)
    const controller = new AbortController()
    controllers.set(reference.id, controller)
    try {
      if (reference.sha256) {
        let verifiedSize: number | undefined
        try { const file = await vault.verify(reference.sha256, reference.size); verifiedSize = reference.size ?? (await stat(file)).size } catch {}
        controller.signal.throwIfAborted()
        own(event, reference.id)
        if (verifiedSize !== undefined) {
          if (!['saved', 'reused'].includes(reference.status) || reference.size === undefined) {
            getChatStore().assets.attachmentSaved(reference.id, reference.sha256, verifiedSize, true)
            broadcast(profile.id)
          }
          owners.delete(reference.id); controllers.delete(reference.id)
          return { id: reference.id, saved: true }
        }
        getChatStore().assets.attachmentFailed(reference.id, '原件无法读取或校验失败，正在重新收纳')
        broadcast(profile.id)
      }
      await vault.begin(reference.id)
      controller.signal.throwIfAborted()
      own(event, reference.id)
      getChatStore().assets.attachmentPending(reference.id)
      return { id: reference.id, saved: false }
    } catch (error) {
      if (controllers.get(reference.id) === controller) {
        await vault.abort(reference.id)
      }
      if (controllers.get(reference.id) === controller) {
        owners.delete(reference.id); controllers.delete(reference.id)
        getChatStore().assets.attachmentFailed(reference.id, String(error))
      }
      broadcast(profile.id)
      throw error
    }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_CHUNK, async (event, id: string, offset: number, bytes: Uint8Array) => {
    own(event, id)
    const controller = controllers.get(id)!
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Invalid original fragment')
    await vault.append(id, offset, bytes)
    controller.signal.throwIfAborted()
    own(event, id)
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_FINISH, async (event, id: string, size: number) => {
    const profile = own(event, id)
    const controller = controllers.get(id)!
    try {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid original size')
      const original = await vault.finish(id, size, getChatStore().assets.getAttachment(id)?.sha256)
      controller.signal.throwIfAborted()
      own(event, id)
      getChatStore().assets.attachmentSaved(id, original.sha256, original.size, original.reused)
      broadcast(profile.id)
      return { ok: true }
    } catch (error) {
      if (controllers.get(id) === controller) await vault.abort(id)
      if (controllers.get(id) === controller) getChatStore().assets.attachmentFailed(id, String(error))
      broadcast(profile.id)
      throw error
    } finally { if (controllers.get(id) === controller) { owners.delete(id); controllers.delete(id) } }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_FAIL, async (event, id: string, error: string) => {
    const profile = own(event, id)
    const controller = controllers.get(id)!
    await vault.abort(id)
    if (controllers.get(id) !== controller) return
    owners.delete(id); controllers.delete(id)
    getChatStore().assets.attachmentFailed(id, typeof error === 'string' ? error : '原件获取失败')
    broadcast(profile.id)
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_FETCH, async (event, id: string) => {
    const profile = own(event, id)
    const controller = controllers.get(id)!
    try {
      const url = getChatStore().assets.getAttachment(id)?.sourceUrl
      if (!url || !/^https?:\/\//.test(url)) throw new Error('Original URL is unavailable')
      const response = await event.sender.session.fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) })
      if (!response.ok || !response.body) throw new Error(`Original fetch failed: HTTP ${response.status}`)
      const reader = response.body.getReader()
      let offset = 0
      try {
        for (;;) {
          const part = await reader.read()
          controller.signal.throwIfAborted()
          if (part.done) break
          await vault.append(id, offset, part.value)
          offset += part.value.byteLength
        }
      } finally { reader.releaseLock() }
      controller.signal.throwIfAborted()
      const original = await vault.finish(id, offset, getChatStore().assets.getAttachment(id)?.sha256)
      controller.signal.throwIfAborted()
      own(event, id)
      getChatStore().assets.attachmentSaved(id, original.sha256, original.size, original.reused)
      broadcast(profile.id)
      return { ok: true }
    } catch (error) {
      if (controllers.get(id) === controller) await vault.abort(id)
      if (controllers.get(id) === controller) getChatStore().assets.attachmentFailed(id, String(error))
      broadcast(profile.id)
      return { ok: false, error: String(error) }
    } finally { if (controllers.get(id) === controller) { owners.delete(id); controllers.delete(id) } }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_ASSOCIATE, (event, observation: AssetObservation, key: string, ids: string[], messageId?: string) => {
    const profile = source(event)
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || (messageId !== undefined && typeof messageId !== 'string')) throw new Error('Invalid attachment references')
    getChatStore().assets.associateAttachments(profile.id, observation, key, ids, messageId)
    broadcast(profile.id)
  })
  ipcMain.handle(ipc.ASSET_DETAILS, (event, id: string) => { local(event); return getChatStore().assets.details(id) })
  ipcMain.handle(ipc.ASSET_COLLECTION_ISSUES, event => { local(event); return [...collectionIssues.values()] })
  ipcMain.handle(ipc.ASSET_FOCUS_PAGE, (event, id: number) => {
    local(event)
    if (!guests.has(id)) return false
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed()) return false
    const window = (guest as unknown as { getOwnerBrowserWindow(): BrowserWindow | null }).getOwnerBrowserWindow()
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    window.show(); window.focus(); guest.focus()
    return true
  })
  ipcMain.handle(ipc.ASSET_FREEZE_TARGETS, event => {
    local(event)
    return [...guests].flatMap(id => {
      const guest = webContents.fromId(id)
      if (!guest || guest.isDestroyed()) return []
      if (!/^https?:\/\//.test(guest.getURL())) return []
      const profile = profileStore.list().find(p => p.isAIPlatform && session.fromPartition(`persist:${p.id}`) === guest.session)
      if (!profile) return []
      const known = getRecordByWebContentsId(id)
      return [{ tabId: known?.tabId ?? `asset-page:${id}`, profileId: profile.id,
        windowId: known?.windowId ?? `asset-window:${id}`, webContentsId: id,
        title: `${profile.name} · ${guest.getTitle()}`, url: guest.getURL() }]
    })
  })
  ipcMain.handle(ipc.ASSET_USAGE, (event, sourceId?: string, conversationId?: string) => { local(event); return getChatStore().assets.usage(sourceId, conversationId) })
  const graph = (id: string) => getChatStore().assets.graph.view(id, getChatStore().listMessages(id))
  ipcMain.handle(ipc.ASSET_GRAPH, (event, id: string) => { local(event); return graph(id) })
  ipcMain.handle(ipc.ASSET_SELECT_BRANCH, (event, id: string, nodeId: string) => { local(event); getChatStore().assets.graph.select(id, nodeId); return graph(id) })
  ipcMain.handle(ipc.ASSET_SUMMARIES, event => { local(event); return getChatStore().assets.graph.summaries() })
  ipcMain.handle(ipc.ASSET_VIEW, (event, id: string, eventId: string) => {
    local(event)
    if (typeof eventId !== 'string' || eventId.length > 200) throw new Error('Invalid view event')
    getChatStore().assets.graph.viewEvent(id, `local:${eventId}`)
  })
  ipcMain.handle(ipc.ASSET_DELETE_CONVERSATION, (event, id: string) => { local(event); getChatStore().deleteConversation(id); broadcast('local') })
  ipcMain.handle(ipc.ASSET_DELETE_MESSAGE, (event, id: string) => { local(event); getChatStore().deleteMessage(id); broadcast('local') })
  ipcMain.handle(ipc.ASSET_RENAME_CONVERSATION, (event, id: string, title: string) => { local(event); getChatStore().assets.renameConversation(id, title); broadcast('local') })
  ipcMain.handle(ipc.ASSET_CLEANUP_RECORDS, event => { local(event); return getChatStore().assets.cleanupRecords() })
  ipcMain.handle(ipc.ASSET_SETTINGS, event => { local(event); return getAssetSettings() })
  ipcMain.handle(ipc.ASSET_SETTINGS_UPDATE, (event, changes) => {
    local(event)
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid asset settings')
    const next = updateAssetSettings(changes)
    broadcastToAllWindows(ipc.ASSET_SETTINGS_CHANGED, next, 'assets')
    return next
  })
  ipcMain.handle(ipc.ASSET_COPY_TEXT, (event, content: string) => {
    local(event)
    if (typeof content !== 'string' || content.length > 16 * 1024 * 1024) throw new Error('Invalid clipboard text')
    clipboard.writeText(content)
  })
  ipcMain.handle(ipc.ASSET_PREVIEW_CODE, (event, content: string, language: 'html' | 'css' | 'javascript') => { local(event); return previewAssetCode(content, language) })
  ipcMain.handle(ipc.ASSET_ATTACHMENTS, (event, id?: string) => { local(event); return getChatStore().assets.attachments(id) })
  ipcMain.handle(ipc.ASSET_SUGGESTIONS, event => { local(event); return getChatStore().assets.suggestions() })
  ipcMain.handle(ipc.ASSET_SEARCH, (event, query: string) => { local(event); return getChatStore().assets.searchConversations(query) })
  const verifiedAttachment = async (id: string) => {
    const item = getChatStore().assets.getAttachment(id)
    if (!item?.sha256) throw new Error('原件尚未收纳')
    try { return { item, file: await vault.verify(item.sha256, item.size) } }
    catch {
      const message = '原件无法读取或校验失败，请重试收纳'
      getChatStore().assets.attachmentFailed(item.id, message)
      broadcast(item.sourceId)
      throw new Error(message)
    }
  }
  ipcMain.handle(ipc.ASSET_ATTACHMENT_OPEN, async (event, id: string) => {
    local(event)
    try {
      const { file } = await verifiedAttachment(id)
      shell.showItemInFolder(file)
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_EXPORT, async (event, id: string) => {
    local(event)
    try {
      const { item, file } = await verifiedAttachment(id)
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: '导出资料原件', defaultPath: path.basename(item.name).replace(/[<>:"/\\|?*]/g, '_'),
      })
      if (result.canceled || !result.filePath) return { ok: false, canceled: true }
      await copyFile(file, result.filePath)
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_RETRY, async (event, id: string) => {
    local(event)
    if (!isModuleEnabled('prompt-library')) return { ok: false, error: '请先启用 AI资产再重试' }
    const item = getChatStore().assets.getAttachment(id)
    if (!item || owners.has(id)) return { ok: false, error: '资料不存在或正在传输' }
    const profile = profileStore.get(item.sourceId)
    if (item.sha256 || /^https?:\/\//.test(item.sourceUrl ?? '')) {
      await acquireLinkedOriginal(item, profile ? session.fromPartition(`persist:${profile.id}`).fetch.bind(session.fromPartition(`persist:${profile.id}`)) : undefined)
      broadcast(item.sourceId)
      const result = getChatStore().assets.getAttachment(id)
      return { ok: result?.status === 'saved' || result?.status === 'reused', error: result?.error }
    }
    const targets = [...guests].map(guest => webContents.fromId(guest)).filter(guest => guest && !guest.isDestroyed()
      && guest.session === session.fromPartition(`persist:${profile?.id}`))
    if (!targets.length) return { ok: false, error: '请先打开资料所在的 AI 页面，再重试' }
    getChatStore().assets.attachmentFailed(id, '请在原页面重新上传资料；页面重载后临时文件可能已失效')
    for (const guest of targets) guest!.send(ipc.ASSET_RETRY_REQUEST, { id, sourceUrl: item.sourceUrl })
    return { ok: true }
  })
}
