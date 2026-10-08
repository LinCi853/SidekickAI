import { ipcRenderer } from 'electron'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AssetAttachmentInput, AssetObservedMessage, AssetObservationReceipt } from '../shared/ai-assets.types.js'
import { stableWebConversationUrl } from './conversation-identity.js'
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
  let documentKey = crypto.randomUUID()
  let lastLocation = ''
  let announcedLocation = ''
  let visitId = crypto.randomUUID()
  let lastSnapshot = ''
  let scheduledSnapshot: { fingerprint: string; sequence: number } | undefined
  let sequence = 0
  const suppressed = new Set<string>()
  const rejectedSignatures = new Set<string>()
  let documentMessages = new Map<string, AssetObservedMessage>()
  let lastMessageShape = ''
  let lastMessageElements: Element[] = []
  let awaitingRouteContent: { shape: string; elements: Element[] } | undefined
  let draftTransition: { key: string; messages: Map<string, AssetObservedMessage> } | undefined
  const aliases = new Map<string, string>()
  type Original = {
    input: AssetAttachmentInput; url?: string; blob?: Blob; id?: string; ready?: Promise<void>
    inputUsers?: Map<string, string>; associating?: boolean; retired?: boolean; ownsTransfer?: boolean; transferId?: string
  }
  type StartedOriginal = { id?: string; saved?: boolean; busy?: boolean; suppressed?: boolean; transferId?: string }
  const originals = new Map<string, Original>()
  const pendingInputs = new Set<string>()
  const retryWaits = new Set<() => void>()
  const lifetime = new AbortController()
  let queue = Promise.resolve()
  let originalQueue = Promise.resolve()
  let stopped = false
  let paused = false
  let journalWaiting = false
  let pendingObservations = 0
  let pendingBytes = 0
  const pendingBudget = 16 * 1024 * 1024
  const context = () => {
    const url = location.href
    return { conversationKey: stableWebConversationUrl(url) ?? `document:${documentKey}`,
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
  const retryInvoke = async <T>(channel: string, args: unknown[], enabled = () => !stopped,
    retired?: (value: T) => Promise<void>): Promise<{ value: T } | undefined> => {
    let failures = 0
    while (enabled()) {
      try {
        const value = await invoke(channel, ...args) as T
        if (!enabled()) { await retired?.(value); return undefined }
        if (enabled() && channel === ipc.ASSET_OBSERVE) journalWaiting = false
        return { value }
      } catch (error) {
        if (!enabled()) return
        if (channel === ipc.ASSET_OBSERVE) { journalWaiting = true; pauseCapture() }
        console.warn('[ai-assets] Collection retry:', channel, error)
        await waitForRetry(1000 * 2 ** Math.min(failures++, 3))
      }
    }
  }
  const enqueue = (operation: () => Promise<void>) => {
    queue = queue.then(() => { if (!stopped) return operation() }).catch(error => console.warn('[ai-assets] Collection failed:', error))
  }
  const cancelOriginal = async (started: StartedOriginal) => {
    if (started.id && started.transferId && !started.saved && !started.busy)
      await invoke(ipc.ASSET_ATTACHMENT_FAIL, started.id, '页面采集已结束，原件传输未完成', started.transferId).catch(() => {})
  }
  const transfer = async (entry: Original, initial?: StartedOriginal) => {
    if (!active(entry)) return
    const started = initial ?? await invoke(ipc.ASSET_ATTACHMENT_BEGIN, entry.input)
    if (!active(entry)) { await cancelOriginal(started); return }
    if (started.suppressed || !started.id) { entry.retired = true; entry.blob = undefined; return }
    entry.id = started.id
    entry.transferId = started.transferId
    if (started.saved) { entry.blob = undefined; return }
    if (started.busy) return
    entry.ownsTransfer = true
    try {
      if (!entry.blob && /^https?:/.test(entry.input.sourceUrl ?? '')) {
        await invoke(ipc.ASSET_ATTACHMENT_FETCH, started.id)
        entry.ownsTransfer = false
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
      entry.ownsTransfer = false
      if (active(entry)) entry.blob = undefined
    } catch (error) {
      if (active(entry)) await invoke(ipc.ASSET_ATTACHMENT_FAIL, started.id, String(error), started.transferId).catch(() => {})
      entry.ownsTransfer = false
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
      return retryInvoke<StartedOriginal>(ipc.ASSET_ATTACHMENT_BEGIN, [metadata], () => active(entry), cancelOriginal)
    }).then(async started => {
      if (!started) return
      if (!active(entry)) { await cancelOriginal(started.value); return }
      if (started.value.suppressed || !started.value.id) { entry.retired = true; entry.blob = undefined; pendingInputs.delete(key); return }
      entry.id = started.value.id
      entry.transferId = started.value.transferId
      entry.ownsTransfer = !started.value.saved && !started.value.busy
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
    if (stopped || paused) return
    let source = context()
    if (source.conversationKey.startsWith('document:') && lastLocation && !lastLocation.startsWith('document:')) {
      documentKey = crypto.randomUUID()
      documentMessages = new Map()
      source = context()
    }
    if (lastLocation !== source.conversationKey) {
      // A route can change before the previous conversation's DOM is replaced.
      if (lastLocation && !lastLocation.startsWith('document:')
        && ['aistudio.xiaomimimo.com', 'chatglm.cn', 'www.chatglm.cn'].includes(location.hostname))
        awaitingRouteContent = { shape: lastMessageShape, elements: lastMessageElements }
      draftTransition = lastLocation.startsWith('document:') && !source.conversationKey.startsWith('document:')
        ? { key: lastLocation, messages: documentMessages } : undefined
      lastLocation = source.conversationKey
      visitId = crypto.randomUUID(); lastSnapshot = ''; scheduledSnapshot = undefined
    }
    if (suppressed.has(source.conversationKey)) return
    const snapshot = readDomConversation(document, location.hostname)
    const found = snapshot.messages
    const shape = JSON.stringify(found.map(({ observed }) => [observed.role, observed.content, observed.reasoning, observed.versionKey]))
    if (awaitingRouteContent && shape === awaitingRouteContent.shape
      && found.length === awaitingRouteContent.elements.length
      && found.every((message, index) => message.element === awaitingRouteContent!.elements[index])) return
    awaitingRouteContent = undefined
    lastMessageShape = shape
    lastMessageElements = found.map(message => message.element)
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
    const observedMessages = found.map(message => message.observed)
    const rejectedCapture = snapshot.rejected
    const completePath = snapshot.completePath
    if (!found.length && !snapshot.rejected.length) return
    if (fingerprint === (scheduledSnapshot?.fingerprint ?? lastSnapshot)
      && (!found.length || announcedLocation === source.conversationKey || scheduledSnapshot)) {
      return
    }
    const observationSequence = ++sequence
    const observationId = crypto.randomUUID()
    const inputAttachments = inputs.flatMap(input => {
      const entry = originals.get(input.key)
      return entry ? [{ externalKey: entry.input.externalKey, messageKey: input.messageKey }] : []
    })
    scheduledSnapshot = { fingerprint, sequence: observationSequence }
    const retainedBytes = (fingerprint.length + JSON.stringify({ ...source, previousConversationKey, observationId,
      messages: observedMessages, snapshot: true, completePath, inputAttachments,
      visitId: eventId, adapter: 'dom-conversation/2', rejected: rejectedCapture }).length) * 2
    pendingObservations += 1
    pendingBytes += retainedBytes
    if (pendingBytes >= pendingBudget) pauseCapture()
    enqueue(async () => {
      try {
      if (suppressed.has(source.conversationKey)) return
      const rejected = []
      const signatures = []
      for (const item of rejectedCapture) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.content))
        const signature = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
        const identity = `${source.conversationKey}:${item.key}:${signature}`
        if (rejectedSignatures.has(identity)) continue
        signatures.push(identity)
        rejected.push({ key: item.key, reason: item.reason, signature })
      }
      if (!observedMessages.length && !rejected.length) return
      const result = await retryInvoke<AssetObservationReceipt>(ipc.ASSET_OBSERVE, [{ ...source, previousConversationKey, observationId,
        messages: observedMessages, snapshot: true, completePath,
        inputAttachments,
        visitId: eventId, adapter: 'dom-conversation/2', rejected }], () => !stopped && !suppressed.has(source.conversationKey))
      if (!result) return
      if (result.value.suppressed) { suppressed.add(source.conversationKey); return }
      signatures.forEach(signature => rejectedSignatures.add(signature))
      if (previousConversationKey) aliases.set(source.conversationKey, previousConversationKey)
      if (eventId === visitId) {
        if (observedMessages.length) announcedLocation = source.conversationKey
        lastSnapshot = fingerprint
        if (scheduledSnapshot?.sequence === observationSequence) scheduledSnapshot = undefined
        if (observedMessages.length && draftTransition === transition) draftTransition = undefined
      }
      if (result.value.durable) {
        inputs.forEach(input => pendingInputs.delete(input.key))
        return
      }
      associate(source, inputs.flatMap(input => {
        const messageId = result.value.messageIds?.[input.messageKey]
        return result.value.messageIds && !messageId ? [] : [{ ...input, messageId }]
      }))
      } finally {
        pendingObservations -= 1
        pendingBytes -= retainedBytes
        if (paused && !stopped) {
          if (!journalWaiting && pendingBytes < pendingBudget / 2) resumeCapture()
          else reportCapture()
        }
      }
    })
  }
  const files = (values: FileList | File[] | null) => {
    if (stopped || paused || !values) return
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
  let routeTimer: ReturnType<typeof setInterval> | undefined = setInterval(scan, 1000)
  window.addEventListener('popstate', navigation)
  window.addEventListener('hashchange', navigation)
  function pauseCapture() {
    if (paused || stopped) return
    paused = true
    observer.disconnect()
    clearInterval(routeTimer)
    routeTimer = undefined
    document.removeEventListener('change', change, true)
    document.removeEventListener('drop', drop, true)
    document.removeEventListener('paste', paste, true)
    reportCapture()
  }
  function resumeCapture() {
    if (!paused || stopped || journalWaiting || pendingBytes >= pendingBudget / 2) return
    paused = false
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['src', 'href', 'data-streaming', 'data-is-streaming', 'aria-busy', 'data-message-id', 'data-status', 'data-branch-index', 'data-branch-count', 'data-version-id'] })
    routeTimer = setInterval(scan, 1000)
    document.addEventListener('change', change, true)
    document.addEventListener('drop', drop, true)
    document.addEventListener('paste', paste, true)
    reportCapture()
  }
  function reportCapture() {
    void invoke(ipc.ASSET_COLLECTOR_REPORT, { paused, pendingObservations, pendingBytes }).catch(() => {})
  }
  const retry = (_event: unknown, payload: { id: string; sourceUrl?: string }) => {
    if (stopped) return
    const entry = [...originals.values()].find(item => item.id === payload.id)
    if (entry) originalQueue = originalQueue.then(() => transfer(entry)).catch(error => console.warn('[ai-assets] Original retry failed:', error))
  }
  ipcRenderer.on(ipc.ASSET_RETRY_REQUEST, retry)
  const cleanup = () => {
    stopped = true; lifetime.abort(); observer.disconnect(); clearInterval(routeTimer)
    for (const entry of originals.values()) {
      entry.retired = true
      entry.blob = undefined
      if (entry.ownsTransfer) void cancelOriginal({ id: entry.id, transferId: entry.transferId })
      entry.ownsTransfer = false
    }
    originals.clear(); pendingInputs.clear(); documentMessages.clear(); aliases.clear()
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
