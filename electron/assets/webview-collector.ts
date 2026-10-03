import { ipcRenderer } from 'electron'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AssetAttachmentInput, AssetObservedMessage } from '../shared/ai-assets.types.js'
import { canonicalWebConversationUrl } from './conversation-identity.js'
import { readDomConversation } from './dom-messages.js'

export async function startAiAssetCollector(): Promise<void> {
  let cleanup: (() => void) | undefined
  let generation = 0
  let disposed = false
  const update = async () => {
    if (disposed) return
    const operation = ++generation
    const enabled = await ipcRenderer.invoke(ipc.ASSET_AUTHORIZE).catch(() => false)
    if (operation !== generation) return
    if (enabled && !cleanup) cleanup = collectAiAssets()
    if (!enabled && cleanup) { cleanup(); cleanup = undefined }
  }
  const changed = (_event: unknown, enabled?: boolean) => {
    if (enabled === false) {
      generation += 1
      cleanup?.(); cleanup = undefined
    } else void update()
  }
  ipcRenderer.on(ipc.ASSET_COLLECTOR_STATE, changed)
  window.addEventListener('pagehide', () => {
    disposed = true
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
  let scheduledSnapshot: { fingerprint: string; sequence: number } | undefined
  let sequence = 0
  const suppressed = new Set<string>()
  const rejectedSignatures = new Set<string>()
  let documentMessages = new Map<string, AssetObservedMessage>()
  let draftTransition: { key: string; messages: Map<string, AssetObservedMessage> } | undefined
  const aliases = new Map<string, string>()
  type Original = {
    input: AssetAttachmentInput; url?: string; blob?: Blob; id?: string; ready?: Promise<void>
    inputUsers?: Map<string, string>; associating?: boolean; retired?: boolean
  }
  type StartedOriginal = { id?: string; saved?: boolean; busy?: boolean; suppressed?: boolean }
  const originals = new Map<string, Original>()
  const pendingInputs = new Set<string>()
  const retryWaits = new Set<() => void>()
  const lifetime = new AbortController()
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
  const active = (entry: Original) => !stopped && !entry.retired && !suppressed.has(entry.input.conversationKey)
  const userSignature = (message: AssetObservedMessage) => JSON.stringify([message.versionKey, message.content])
  const waitForRetry = (delay: number) => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); retryWaits.delete(finish); resolve() }
    const timer = setTimeout(finish, delay)
    retryWaits.add(finish)
  })
  const retryInvoke = async <T>(channel: string, args: unknown[], enabled = () => !stopped): Promise<{ value: T } | undefined> => {
    let failures = 0
    while (enabled()) {
      try {
        const value = await invoke(channel, ...args) as T
        return enabled() ? { value } : undefined
      } catch (error) {
        if (!enabled()) return
        console.warn('[ai-assets] Collection retry:', channel, error)
        await waitForRetry(1000 * 2 ** Math.min(failures++, 3))
      }
    }
  }
  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(() => { if (!stopped) return operation() }).catch(error => console.warn('[ai-assets] Collection failed:', error))
  }
  const transfer = async (entry: Original, initial?: StartedOriginal) => {
    if (!active(entry)) return
    const started = initial ?? await invoke(ipc.ASSET_ATTACHMENT_BEGIN, entry.input)
    if (!active(entry)) return
    if (started.suppressed || !started.id) { entry.retired = true; entry.blob = undefined; return }
    entry.id = started.id
    if (started.saved) { entry.blob = undefined; return }
    if (started.busy) return
    try {
      if (!entry.blob && /^https?:/.test(entry.input.sourceUrl ?? '')) {
        await invoke(ipc.ASSET_ATTACHMENT_FETCH, started.id)
        return
      }
      const blob = entry.blob ?? await fetch(entry.url ?? entry.input.sourceUrl!, { credentials: 'include', signal: lifetime.signal }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.blob()
      })
      if (!active(entry)) return
      if (!blob) throw new Error('Original bytes are unavailable')
      for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer())
        if (!active(entry)) return
        await invoke(ipc.ASSET_ATTACHMENT_CHUNK, started.id, offset, bytes)
      }
      if (!active(entry)) return
      await invoke(ipc.ASSET_ATTACHMENT_FINISH, started.id, blob.size)
      if (active(entry)) entry.blob = undefined
    } catch (error) {
      if (active(entry)) await invoke(ipc.ASSET_ATTACHMENT_FAIL, started.id, String(error)).catch(() => {})
    }
  }
  const acquire = (input: AssetAttachmentInput, blob?: Blob) => {
    if (stopped || suppressed.has(input.conversationKey)) return
    const key = `${input.conversationKey}\u0000${input.externalKey}`
    if (originals.has(key)) return
    const entry: Original = { input, blob, url: input.sourceUrl,
      inputUsers: input.direction === 'input' ? new Map(readDomConversation(document, location.hostname).messages
        .filter(message => message.observed.role === 'user').map(message => [message.observed.key, userSignature(message.observed)])) : undefined }
    originals.set(key, entry)
    entry.ready = Promise.resolve().then(async () => {
      if (!active(entry)) return
      const metadata = { ...entry.input }
      if (/^data:/.test(metadata.sourceUrl ?? '')) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(metadata.externalKey))
        metadata.sourceUrl = '内联资料'
        metadata.externalKey = `${metadata.messageKey}:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`
      }
      if (!active(entry)) return
      entry.input = metadata
      return retryInvoke<StartedOriginal>(ipc.ASSET_ATTACHMENT_BEGIN, [metadata], () => active(entry))
    }).then(started => {
      if (!started) return
      if (started.value.suppressed || !started.value.id) { entry.retired = true; entry.blob = undefined; pendingInputs.delete(key); return }
      entry.id = started.value.id
      originalQueue = originalQueue.then(() => transfer(entry, started.value)).catch(error => console.warn('[ai-assets] Original transfer failed:', error))
    }).catch(error => console.warn('[ai-assets] Original metadata failed:', error))
    if (input.direction === 'input') pendingInputs.add(key)
  }
  const associate = (source: ReturnType<typeof context>, inputs: Array<{ key: string; messageKey: string; messageId?: string }>) => {
    const groups = new Map<string, { messageId?: string; entries: Array<{ key: string; entry: Original }> }>()
    for (const input of inputs) {
      const entry = originals.get(input.key)
      if (!entry || entry.associating || !pendingInputs.has(input.key) || !active(entry)) continue
      entry.associating = true
      const group = groups.get(input.messageKey) ?? { messageId: input.messageId, entries: [] }
      group.entries.push({ key: input.key, entry }); groups.set(input.messageKey, group)
    }
    for (const [messageKey, { messageId, entries }] of groups) {
      void Promise.all(entries.map(({ entry }) => entry.ready)).then(async () => {
        const ready = entries.filter(({ entry }) => entry.id && active(entry))
        if (!ready.length || stopped || suppressed.has(source.conversationKey)) return
        const result = await retryInvoke(ipc.ASSET_ATTACHMENT_ASSOCIATE, [source, messageKey, ready.map(({ entry }) => entry.id!), messageId],
          () => !stopped && !suppressed.has(source.conversationKey))
        if (result) ready.forEach(({ key }) => pendingInputs.delete(key))
      }).catch(error => console.warn('[ai-assets] Original association failed:', error))
        .finally(() => { entries.forEach(({ entry }) => { entry.associating = false }) })
    }
  }
  const scan = () => {
    if (stopped) return
    const source = context()
    if (lastLocation !== source.conversationKey) {
      draftTransition = lastLocation.startsWith('document:') && !source.conversationKey.startsWith('document:')
        ? { key: lastLocation, messages: documentMessages } : undefined
      lastLocation = source.conversationKey
      visitId = crypto.randomUUID(); lastSnapshot = ''; scheduledSnapshot = undefined
    }
    if (suppressed.has(source.conversationKey)) return
    const snapshot = readDomConversation(document, location.hostname)
    const found = snapshot.messages
    const next = new Map(found.map(message => [message.observed.key, message.observed]))
    if (source.conversationKey.startsWith('document:') && found.length) documentMessages = next
    const transition = draftTransition
    const previousConversationKey = transition && (!transition.messages.size || found.some(({ observed }) =>
      transition.messages.get(observed.key)?.content === observed.content)) ? transition.key : undefined
    const fingerprint = JSON.stringify([[...next.values()], snapshot.rejected.map(item => [item.key, item.content])])
    const inputAlias = previousConversationKey ?? aliases.get(source.conversationKey)
    const inputs = [...pendingInputs].flatMap(key => {
      const entry = originals.get(key)
      if (!entry || (entry.input.conversationKey !== source.conversationKey && entry.input.conversationKey !== inputAlias)) return []
      const nextUser = found.find(({ observed }) => observed.role === 'user' && entry.inputUsers?.get(observed.key) !== userSignature(observed))
      return nextUser ? [{ key, messageKey: nextUser.observed.key }] : []
    })
    const eventId = visitId
    if (!found.length && !snapshot.rejected.length) return
    if (fingerprint === (scheduledSnapshot?.fingerprint ?? lastSnapshot)
      && (!found.length || announcedLocation === source.conversationKey || scheduledSnapshot)) {
      return
    }
    const observationSequence = ++sequence
    scheduledSnapshot = { fingerprint, sequence: observationSequence }
    enqueue(async () => {
      if (suppressed.has(source.conversationKey)) return
      const rejected = []
      const signatures = []
      for (const item of snapshot.rejected) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.content))
        const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
        const identity = `${source.conversationKey}:${item.key}:${signature}`
        if (rejectedSignatures.has(identity)) continue
        signatures.push(identity)
        rejected.push({ key: item.key, reason: item.reason, signature })
      }
      if (!found.length && !rejected.length) return
      const result = await retryInvoke<{ suppressed?: boolean; messageIds?: Record<string, string> }>(ipc.ASSET_OBSERVE, [{ ...source, previousConversationKey,
        messages: found.map(message => message.observed), snapshot: true, completePath: snapshot.completePath,
        visitId: eventId, adapter: 'dom-conversation/2', rejected }], () => !stopped && !suppressed.has(source.conversationKey))
      if (!result) return
      if (result.value.suppressed) { suppressed.add(source.conversationKey); return }
      signatures.forEach(signature => rejectedSignatures.add(signature))
      if (previousConversationKey) aliases.set(source.conversationKey, previousConversationKey)
      if (eventId === visitId) {
        if (found.length) announcedLocation = source.conversationKey
        lastSnapshot = fingerprint
        if (scheduledSnapshot?.sequence === observationSequence) scheduledSnapshot = undefined
        if (found.length && draftTransition === transition) draftTransition = undefined
      }
      associate(source, inputs.flatMap(input => {
        const messageId = result.value.messageIds?.[input.messageKey]
        return result.value.messageIds && !messageId ? [] : [{ ...input, messageId }]
      }))
    })
  }
  const files = (values: FileList | File[] | null) => {
    if (stopped || !values) return
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
    if (stopped) return
    const entry = [...originals.values()].find(item => item.id === payload.id)
    if (entry) originalQueue = originalQueue.then(() => transfer(entry)).catch(error => console.warn('[ai-assets] Original retry failed:', error))
    else void invoke(ipc.ASSET_ATTACHMENT_FAIL, payload.id, '原页面中的临时资料已失效，请重新上传或重新打开资料链接').catch(() => {})
  }
  ipcRenderer.on(ipc.ASSET_RETRY_REQUEST, retry)
  const cleanup = () => {
    stopped = true; lifetime.abort(); observer.disconnect(); clearInterval(routeTimer)
    for (const cancel of retryWaits) cancel()
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
