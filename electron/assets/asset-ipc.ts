import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, webContents, type IpcMainInvokeEvent } from 'electron'
import { copyFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getChatStore } from '../store/chat-store.js'
import { profileStore } from '../store/profile-store.js'
import { isModuleEnabled, observeModuleState } from '../modules/registry.js'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AssetAttachmentInput, AssetCollectionIssue, AssetObservation } from '../shared/ai-assets.types.js'
import { OriginalVault } from './original-vault.js'
import { attachmentFileName, createAttachmentCopy } from './attachment-file.js'
import { acquireLinkedOriginal, stopLinkedOriginalTransfers, hasLinkedOriginalTransfers } from './api-originals.js'
import { getRecordByWebContentsId } from '../freeze/webview-registry.js'
import { getAssetSettings, updateAssetSettings } from './settings.js'
import { previewAssetCode } from './code-preview.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { cleanSelectedAttachments, recoverSelectedCleanup } from './selected-cleanup.js'
import { hasActiveAssetImports } from './import-activity.js'
import { hasActiveBackupExports } from '../store/backup-activity.js'
import { isImportingData } from '../store/import-guard.js'
import { AssetObservationJournal, setAssetCollectionJournal } from './collection-journal.js'

let stopTransfers: (() => void) | undefined
let transfersActive: () => boolean = () => false
let observationJournal: AssetObservationJournal | undefined
export function hasWebOriginalTransfers(): boolean { return transfersActive() }
export { closeAssetCollectionJournal } from './collection-journal.js'
export function clearAssetCollectionJournal(clearDatabase?: (filename: string) => void): void {
  if (isModuleEnabled('prompt-library') || transfersActive() || hasLinkedOriginalTransfers()
    || hasActiveAssetImports() || hasActiveBackupExports() || isImportingData)
    throw new Error('Asset collection must be stopped before clearing its journal')
  observationJournal?.pause()
  if (clearDatabase && observationJournal) observationJournal.clearWith(clearDatabase)
  else observationJournal?.clear()
}

export function broadcastAiAssetState(): void {
  if (!isModuleEnabled('prompt-library')) { stopTransfers?.(); stopLinkedOriginalTransfers() }
  for (const guest of webContents.getAllWebContents()) {
    if (!guest.isDestroyed()) guest.send(ipc.ASSET_COLLECTOR_STATE, isModuleEnabled('prompt-library'))
  }
}

export function registerAiAssetIpc(): void {
  const collectionIssues = new Map<number, AssetCollectionIssue>()
  const pausedGuests = new Set<number>()
  const guests = new Map<number, { sender: IpcMainInvokeEvent['sender']; profileId: string }>()
  const currentGuest = (id: number, profileId?: string) => {
    const registered = guests.get(id)
    const guest = webContents.fromId(id)
    if (!registered || !guest || guest !== registered.sender || guest.isDestroyed()
      || (profileId !== undefined && profileId !== registered.profileId)) return undefined
    const profile = profileStore.list().find(profile => profile.id === registered.profileId && profile.isAIPlatform)
    return profile && guest.session === session.fromPartition(`persist:${profile.id}`) ? guest : undefined
  }
  const currentIssues = () => {
    const issues = new Map(observationJournal?.issues().map(issue => {
      const current = [...guests.keys()].find(id => currentGuest(id, issue.profileId))
      return [issue.profileId, { ...issue, webContentsId: current ?? 0 }] as const
    }) ?? [])
    for (const [id, issue] of collectionIssues) {
      if (!currentGuest(id, issue.profileId)) continue
      const stored = issues.get(issue.profileId)
      issues.set(issue.profileId, { ...stored, ...issue, failures: (stored?.failures ?? 0) + issue.failures,
        paused: stored?.paused || issue.paused, pendingObservations: (stored?.pendingObservations ?? 0) + (issue.pendingObservations ?? 0),
        pendingBytes: (stored?.pendingBytes ?? 0) + (issue.pendingBytes ?? 0) })
    }
    return [...issues.values()]
  }
  const publishCollectionIssues = () => {
    const issues = currentIssues()
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed())
      window.webContents.send(ipc.ASSET_COLLECTION_ISSUES_CHANGED, issues)
  }
  let assetEnabled = false
  const syncCollection = () => {
    const enabled = isModuleEnabled('prompt-library')
    if (enabled && !assetEnabled) getChatStore().cleanupInvalidConversations()
    if (!enabled) {
      pausedGuests.clear()
      if (collectionIssues.size) { collectionIssues.clear(); publishCollectionIssues() }
    }
    assetEnabled = enabled
    if (enabled && !hasActiveBackupExports() && !isImportingData) {
      try { observationJournal?.start() } catch (error) { console.warn('[ai-assets] Collection journal is unavailable:', error) }
    } else observationJournal?.pause()
    broadcastAiAssetState()
  }
  observeModuleState(syncCollection)
  syncCollection()
  const vault = new OriginalVault(path.join(app.getPath('userData'), 'ai-assets'), path.join(app.getPath('userData'), '.ai-assets-pending'))
  try { recoverSelectedCleanup(app.getPath('userData'), getChatStore().assets) }
  catch (error) { console.warn('[ai-assets] Pending original cleanup needs attention:', error) }
  const owners = new Map<string, number>()
  const controllers = new Map<string, AbortController>()
  const transferTokens = new WeakMap<AbortController, string>()
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
  const registerGuest = (event: IpcMainInvokeEvent, profileId: string) => {
    if (guests.get(event.sender.id)?.sender === event.sender) return
    guests.set(event.sender.id, { sender: event.sender, profileId })
    const guestId = event.sender.id
    const releaseDocument = (reason: string) => {
      if (guests.get(guestId)?.sender !== event.sender) return
      pausedGuests.delete(guestId)
      if (collectionIssues.delete(guestId)) publishCollectionIssues()
      for (const [id, owner] of owners) if (owner === guestId) {
        abortTransfer(id)
        try { getChatStore().assets.attachmentFailed(id, reason) } catch {}
      }
    }
    event.sender.on('did-start-navigation', (_navigation, _url, inPlace, mainFrame) => {
      if (!inPlace && mainFrame) releaseDocument('页面已重新加载，原件传输未完成')
    })
    event.sender.once('destroyed', () => {
      if (guests.get(guestId)?.sender !== event.sender) return
      releaseDocument('页面已关闭，原件传输未完成')
      guests.delete(guestId)
      publishCollectionIssues()
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
    registerGuest(event, profile.id)
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
  observationJournal?.close()
  observationJournal = new AssetObservationJournal(path.join(app.getPath('userData'), 'asset-collection.db'), {
    authorize: stored => stored.type === 'webview' && isModuleEnabled('prompt-library') && !hasActiveBackupExports() && !isImportingData
      && profileStore.list().some(profile => profile.id === stored.id && profile.isAIPlatform),
    observe: (stored, observation) => getChatStore().assets.observe(stored, observation),
    associate: (stored, observation, externalKey, messageKey, messageId) =>
      getChatStore().assets.associateCapturedInput(stored, observation, externalKey, messageKey, messageId),
    changed: publishCollectionIssues,
    committed: broadcast,
  })
  setAssetCollectionJournal(observationJournal)
  if (assetEnabled && !hasActiveBackupExports() && !isImportingData) {
    try { observationJournal.start() } catch (error) { console.warn('[ai-assets] Collection journal is unavailable:', error) }
  }
  ipcMain.handle(ipc.ASSET_AUTHORIZE, event => {
    try {
      source(event)
      if (!hasActiveBackupExports() && !isImportingData) {
        try { observationJournal?.start() } catch (error) { console.warn('[ai-assets] Collection journal is unavailable:', error) }
      }
      return true
    } catch { return false }
  })
  ipcMain.handle(ipc.ASSET_COLLECTOR_REPORT, (event, state: { paused?: boolean; pendingObservations?: number; pendingBytes?: number }) => {
    const profile = source(event)
    if (!state || typeof state.paused !== 'boolean' || !Number.isSafeInteger(state.pendingObservations)
      || !Number.isSafeInteger(state.pendingBytes) || state.pendingObservations! < 0 || state.pendingBytes! < 0)
      throw new Error('Invalid collector capacity report')
    if (state.paused) {
      pausedGuests.add(event.sender.id)
      collectionIssues.set(event.sender.id, { webContentsId: event.sender.id, profileId: profile.id, profileName: profile.name,
        failures: collectionIssues.get(event.sender.id)?.failures ?? 0, updatedAt: Date.now(), paused: true,
        pendingObservations: state.pendingObservations, pendingBytes: state.pendingBytes })
    } else { pausedGuests.delete(event.sender.id); collectionIssues.delete(event.sender.id) }
    publishCollectionIssues()
  })
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
    if ((observation.observationId !== undefined && (typeof observation.observationId !== 'string' || !observation.observationId || observation.observationId.length > 128))
      || (observation.inputAttachments !== undefined && (!Array.isArray(observation.inputAttachments) || observation.inputAttachments.length > 10000
        || observation.inputAttachments.some(input => typeof input.externalKey !== 'string' || !input.externalKey
          || typeof input.messageKey !== 'string' || !observation.messages.some(message => message.key === input.messageKey && message.role === 'user')))))
      throw new Error('Invalid observation attachment ownership')
    let result
    try {
      if (hasActiveBackupExports() || isImportingData) throw new Error('Asset collection is waiting for the data transfer')
      observationJournal!.start()
      result = observationJournal!.receive(profile, observation, event.sender.id, profile.name)
    }
    catch (error) {
      collectionIssues.set(event.sender.id, { webContentsId: event.sender.id, profileId: profile.id, profileName: profile.name,
        failures: (collectionIssues.get(event.sender.id)?.failures ?? 0) + 1, updatedAt: Date.now(), paused: true })
      publishCollectionIssues()
      throw error
    }
    if (!pausedGuests.has(event.sender.id) && collectionIssues.delete(event.sender.id)) publishCollectionIssues()
    return result
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_BEGIN, async (event, input: AssetAttachmentInput) => {
    const profile = source(event)
    if (!input || typeof input.name !== 'string' || typeof input.externalKey !== 'string'
      || typeof input.conversationKey !== 'string' || !['input', 'output'].includes(input.direction)
      || (input.messageId !== undefined && (typeof input.messageId !== 'string' || typeof input.messageKey !== 'string'))) throw new Error('Invalid original metadata')
    if (input.direction !== 'input' || getChatStore().assets.attachmentExcluded(profile.id, input.externalKey)) return { suppressed: true }
    const reference = getChatStore().assets.beginAttachment(profile, input)
    if (owners.has(reference.id)) return { id: reference.id, busy: true }
    owners.set(reference.id, event.sender.id)
    const controller = new AbortController()
    controllers.set(reference.id, controller)
    const transferId = randomUUID()
    transferTokens.set(controller, transferId)
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
      return { id: reference.id, saved: false, transferId }
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
  ipcMain.handle(ipc.ASSET_ATTACHMENT_FAIL, async (event, id: string, error: string, transferId?: string) => {
    const profile = own(event, id)
    const controller = controllers.get(id)!
    if (transferId !== undefined && transferTokens.get(controller) !== transferId) return
    controller.abort()
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
  ipcMain.handle(ipc.ASSET_COLLECTION_ISSUES, event => { local(event); return currentIssues() })
  ipcMain.handle(ipc.ASSET_FOCUS_PAGE, (event, id: number, expectedProfileId?: string) => {
    local(event)
    if (expectedProfileId !== undefined && (typeof expectedProfileId !== 'string' || !expectedProfileId || expectedProfileId.length > 128))
      throw new Error('Invalid AI asset profile')
    const guest = currentGuest(id, expectedProfileId)
    if (!guest) return false
    const window = (guest as unknown as { getOwnerBrowserWindow(): BrowserWindow | null }).getOwnerBrowserWindow()
    if (!window || window.isDestroyed()) return false
    if (window.isMinimized()) window.restore()
    window.show(); window.focus(); guest.focus()
    return true
  })
  ipcMain.handle(ipc.ASSET_FREEZE_TARGETS, event => {
    local(event)
    return [...guests.keys()].flatMap(id => {
      const guest = currentGuest(id)
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
  ipcMain.handle(ipc.ASSET_OPEN_EXTERNAL, (event, value: string) => {
    local(event)
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) throw new Error('仅支持 HTTP 或 HTTPS 网页链接')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不支持此链接类型')
    return shell.openExternal(url.href)
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
  ipcMain.handle(ipc.ASSET_DELETE_SELECTION, async (event, kind: string, ids: string[]) => {
    local(event)
    if (!['files', 'conversations'].includes(kind) || !Array.isArray(ids) || !ids.length || ids.length > 10000
      || ids.some(id => typeof id !== 'string' || !id || id.length > 200) || new Set(ids).size !== ids.length) throw new Error('Invalid asset selection')
    const { hasActiveAssetStreams } = await import('../ai/handler.js')
    if (hasActiveAssetStreams() || hasWebOriginalTransfers() || hasLinkedOriginalTransfers() || hasActiveAssetImports() || hasActiveBackupExports() || isImportingData)
      throw new Error('请等待响应、导入、备份和原件传输完成后再清理')
    const assets = getChatStore().assets
    const result = kind === 'files' ? cleanSelectedAttachments(app.getPath('userData'), assets, ids)
      : { deleted: assets.deleteConversations(ids), cleanupPending: false }
    broadcast('local')
    return result
  })
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
      const { item, file } = await verifiedAttachment(id)
      let copy: string
      try { copy = await createAttachmentCopy(app.getPath('temp'), file, item) }
      catch (error) {
        console.warn('[ai-assets] Attachment copy failed:', error)
        return { ok: false, error: '无法创建文件副本，请检查临时目录的空间和权限后重试，或导出到其他文件夹' }
      }
      shell.showItemInFolder(copy)
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle(ipc.ASSET_ATTACHMENT_EXPORT, async (event, id: string) => {
    local(event)
    try {
      const { item, file } = await verifiedAttachment(id)
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, {
        title: '导出资料原件', defaultPath: attachmentFileName(item),
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
    const targets = [...guests.keys()].map(guest => currentGuest(guest)).filter(guest => guest && !guest.isDestroyed()
      && guest.session === session.fromPartition(`persist:${profile?.id}`))
    if (!targets.length) return { ok: false, error: '请先打开资料所在的 AI 页面，再重试' }
    getChatStore().assets.attachmentFailed(id, '请在原页面重新上传资料；页面重载后临时文件可能已失效')
    for (const guest of targets) guest!.send(ipc.ASSET_RETRY_REQUEST, { id, sourceUrl: item.sourceUrl })
    return { ok: true }
  })
}
