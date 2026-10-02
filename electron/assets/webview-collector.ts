import { ipcRenderer } from 'electron'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AssetAttachmentInput, AssetObservedMessage } from '../shared/ai-assets.types.js'
import { canonicalWebConversationUrl } from './conversation-identity.js'
import { readDomConversation } from './dom-messages.js'

export async function startAiAssetCollector(): Promise<void> {
  let cleanup: (() => void) | undefined
  let generation = 0
  const update = async () => {
    const operation = ++generation
    const enabled = await ipcRenderer.invoke(ipc.ASSET_AUTHORIZE).catch(() => false)
    if (operation !== generation) return
    if (enabled && !cleanup) cleanup = collectAiAssets()
    if (!enabled && cleanup) { cleanup(); cleanup = undefined }
  }
  const changed = () => { void update() }
  ipcRenderer.on(ipc.ASSET_COLLECTOR_STATE, changed)
  window.addEventListener('pagehide', () => {
    generation += 1
    cleanup?.(); ipcRenderer.removeListener(ipc.ASSET_COLLECTOR_STATE, changed)
  }, { once: true })
  await update()
}

function collectAiAssets(): () => void {
  const documentKey = crypto.randomUUID()
  let lastLocation = ''
  let announcedLocation = ''
  let visitId = crypto.randomUUID()
  let lastSnapshot = ''
  const suppressed = new Set<string>()
  const rejectedSignatures = new Set<string>()
  let previous = new Map<string, AssetObservedMessage>()
  type Original = { input: AssetAttachmentInput; url?: string; blob?: Blob; id?: string; ready?: Promise<void> }
  const originals = new Map<string, Original>()
  const pendingInputs = new Set<string>()
  let queue = Promise.resolve()
  let originalQueue = Promise.resolve()
  let stopped = false
  const context = () => {
    const url = location.href
    const stable = location.pathname !== '/' && location.pathname !== '/chat' && location.pathname !== '/app'
    return { conversationKey: stable ? canonicalWebConversationUrl(url)! : `document:${documentKey}`,
      title: document.title, url }
  }
  const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch(error => console.warn('[ai-assets] Collection failed:', error))
  }
  const transfer = async (entry: Original, initial?: { id: string; saved?: boolean; busy?: boolean }) => {
    const started = initial ?? await invoke(ipc.ASSET_ATTACHMENT_BEGIN, entry.input)
    entry.id = started.id
    if (started.saved) { entry.blob = undefined; return }
    if (started.busy) return
    try {
      if (!entry.blob && /^https?:/.test(entry.input.sourceUrl ?? '')) {
        await invoke(ipc.ASSET_ATTACHMENT_FETCH, started.id)
        return
      }
      const blob = entry.blob ?? await fetch(entry.url ?? entry.input.sourceUrl!, { credentials: 'include' }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.blob()
      })
      if (!blob) throw new Error('Original bytes are unavailable')
      for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer())
        await invoke(ipc.ASSET_ATTACHMENT_CHUNK, started.id, offset, bytes)
      }
      await invoke(ipc.ASSET_ATTACHMENT_FINISH, started.id, blob.size)
      entry.blob = undefined
    } catch (error) {
      await invoke(ipc.ASSET_ATTACHMENT_FAIL, started.id, String(error)).catch(() => {})
    }
  }
  const acquire = (input: AssetAttachmentInput, blob?: Blob) => {
    if (suppressed.has(input.conversationKey)) return
    const key = `${input.conversationKey}\u0000${input.externalKey}`
    if (originals.has(key)) return
    const entry: Original = { input, blob, url: input.sourceUrl }
    originals.set(key, entry)
    entry.ready = queue.then(async () => {
      if (suppressed.has(entry.input.conversationKey)) return
      const metadata = { ...entry.input }
      if (/^data:/.test(metadata.sourceUrl ?? '')) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metadata.externalKey))
        metadata.sourceUrl = '内联资料'
        metadata.externalKey = `${metadata.messageKey}:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
      }
      entry.input = metadata
      return invoke(ipc.ASSET_ATTACHMENT_BEGIN, metadata)
    }).then(started => {
      if (!started) return
      entry.id = started.id
      originalQueue = originalQueue.then(() => transfer(entry, started)).catch(error => console.warn('[ai-assets] Original transfer failed:', error))
    }).catch(error => console.warn('[ai-assets] Original metadata failed:', error))
    if (input.direction === 'input') pendingInputs.add(key)
  }
  const scan = () => {
    if (stopped) return
    const source = context()
    const previousConversationKey = lastLocation.startsWith('document:') && !source.conversationKey.startsWith('document:') ? lastLocation : undefined
    if (lastLocation !== source.conversationKey) {
      previous = new Map(); lastLocation = source.conversationKey
      visitId = crypto.randomUUID(); lastSnapshot = ''
    }
    const snapshot = readDomConversation(document, location.hostname)
    const found = snapshot.messages
    const next = new Map(found.map(message => [message.observed.key, message.observed]))
    const fingerprint = JSON.stringify([[...next.values()], snapshot.rejected.map(item => [item.key, item.content])])
    const newUser = [...found].reverse().find(({ observed }) => {
      const before = previous.get(observed.key)
      return observed.role === 'user' && (!before || before.versionKey !== observed.versionKey || before.content !== observed.content)
    })
    const eventId = visitId
    if (fingerprint !== lastSnapshot || (found.length && announcedLocation !== source.conversationKey)) enqueue(async () => {
      const rejected = []
      for (const item of snapshot.rejected) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.content))
        const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
        const identity = `${source.conversationKey}:${item.key}:${signature}`
        if (rejectedSignatures.has(identity)) continue
        rejectedSignatures.add(identity)
        rejected.push({ key: item.key, reason: item.reason, signature })
      }
      if (!found.length && !rejected.length) return
      const result = await invoke(ipc.ASSET_OBSERVE, { ...source, previousConversationKey,
        messages: found.map(message => message.observed), snapshot: true, completePath: snapshot.completePath,
        visitId: eventId, adapter: 'dom-conversation/2', rejected })
      if (result.suppressed) { suppressed.add(source.conversationKey); return }
      if (newUser && pendingInputs.size) {
        const keys = [...pendingInputs].filter(key => {
          const conversationKey = originals.get(key)?.input.conversationKey
          return conversationKey === source.conversationKey || (previousConversationKey && conversationKey === previousConversationKey)
        })
        await Promise.all(keys.map(key => originals.get(key)?.ready))
        const ids = keys.map(key => originals.get(key)?.id).filter((id): id is string => !!id)
        if (ids.length) {
          await invoke(ipc.ASSET_ATTACHMENT_ASSOCIATE, source, newUser.observed.key, ids)
          keys.forEach(key => pendingInputs.delete(key))
        }
      }
    })
    if (found.length) announcedLocation = source.conversationKey
    lastSnapshot = fingerprint
    previous = next
    if (suppressed.has(source.conversationKey)) return
    for (const [index, message] of found.entries()) {
      if (message.observed.role !== 'assistant') continue
      for (const element of message.element.querySelectorAll('img, a[download], a[data-attachment]')) {
        const image = element instanceof HTMLImageElement
        if (image && element.closest('[data-avatar], .avatar, [data-testid="avatar"]')) continue
        const url = image ? element.currentSrc || element.src : (element as HTMLAnchorElement).href
        if (!url || !/^(https?:|data:|blob:)/.test(url)) continue
        let name = image ? '图片' : element.getAttribute('download') || element.textContent?.trim() || '文件'
        try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || name) } catch {}
        if (name.length > 255 || /^data:/.test(url)) name = image ? '图片' : '文件'
        acquire({ ...source, messageKey: message.observed.key, name, mimeType: image ? 'image/*' : 'application/octet-stream',
          direction: 'output', sourceUrl: url, externalKey: `${JSON.stringify(found.slice(0, index + 1).map(item => [item.observed.key, item.observed.versionKey ?? '']))}:${url}` })
      }
    }
  }
  const files = (values: FileList | File[] | null) => {
    if (!values) return
    for (const file of Array.from(values)) acquire({ ...context(), name: file.name, mimeType: file.type,
      direction: 'input', externalKey: `selected:${crypto.randomUUID()}` }, file)
  }
  const change = (event: Event) => { if (event.target instanceof HTMLInputElement && event.target.type === 'file') files(event.target.files) }
  const drop = (event: DragEvent) => files(event.dataTransfer?.files ?? null)
  const paste = (event: ClipboardEvent) => files(event.clipboardData?.files ?? null)
  document.addEventListener('change', change, true)
  document.addEventListener('drop', drop, true)
  document.addEventListener('paste', paste, true)
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['src', 'href', 'data-streaming', 'data-is-streaming', 'aria-busy', 'data-message-id', 'data-status', 'data-branch-index', 'data-branch-count', 'data-version-id'] })
  const navigation = () => scan()
  const routeTimer = setInterval(scan, 1000)
  window.addEventListener('popstate', navigation)
  window.addEventListener('hashchange', navigation)
  const retry = (_event: unknown, payload: { id: string; sourceUrl?: string }) => {
    const entry = [...originals.values()].find(item => item.id === payload.id)
    if (entry) originalQueue = originalQueue.then(() => transfer(entry)).catch(error => console.warn('[ai-assets] Original retry failed:', error))
    else void invoke(ipc.ASSET_ATTACHMENT_FAIL, payload.id, '原页面中的临时资料已失效，请重新上传或重新打开资料链接').catch(() => {})
  }
  ipcRenderer.on(ipc.ASSET_RETRY_REQUEST, retry)
  const cleanup = () => {
    scan(); stopped = true; observer.disconnect(); clearInterval(routeTimer)
    window.removeEventListener('popstate', navigation)
    window.removeEventListener('hashchange', navigation)
    document.removeEventListener('change', change, true)
    document.removeEventListener('drop', drop, true)
    document.removeEventListener('paste', paste, true)
    ipcRenderer.removeListener(ipc.ASSET_RETRY_REQUEST, retry)
  }
  scan()
  return cleanup
}
