import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const state = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (...args: any[]) => any>(), enabled: true,
  observers: [] as Array<() => void>, session: {}, record: undefined as any,
  observeError: undefined as Error | undefined, messages: [] as Array<[string, unknown]>,
  destination: undefined as string | undefined,
  temporaryRoot: undefined as string | undefined,
  excluded: false, busy: false, guest: undefined as any,
}))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'temp' ? state.temporaryRoot ?? state.root : state.root },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, data: unknown) => state.messages.push([channel, data]) } }], fromWebContents: () => ({}) },
  clipboard: {}, dialog: { showSaveDialog: async () => state.destination ? { canceled: false, filePath: state.destination } : { canceled: true } },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => {}) }, net: { fetch: vi.fn() },
  ipcMain: { handle: (channel: string, callback: (...args: any[]) => any) => state.handlers.set(channel, callback) },
  session: { fromPartition: () => state.session }, webContents: { getAllWebContents: () => [], fromId: (id: number) => id === state.guest?.id ? state.guest : undefined },
}))
vi.mock('../store/chat-store.js', () => ({
  getChatStore: () => ({
    cleanupInvalidConversations: () => {},
    assets: {
      observe: () => { if (state.observeError) throw state.observeError; return { conversationId: 'conversation-a' } },
      beginAttachment: () => state.record,
      attachmentExcluded: () => state.excluded,
      getAttachment: () => state.record,
      attachmentFailed: (_id: string, error: string) => { state.record.status = 'failed'; state.record.error = error },
      attachmentPending: () => { state.record.status = 'pending'; state.record.error = undefined },
      attachmentSaved: (_id: string, sha256: string, size: number, reused: boolean) => {
        Object.assign(state.record, { status: reused ? 'reused' : 'saved', sha256, size, error: undefined })
      },
    },
  }),
}))
vi.mock('../store/profile-store.js', () => ({ profileStore: { list: () => [{ id: 'profile-a', name: 'Account A', isAIPlatform: true }] } }))
vi.mock('../modules/registry.js', () => ({ isModuleEnabled: () => state.enabled, observeModuleState: (callback: () => void) => state.observers.push(callback) }))
vi.mock('../freeze/webview-registry.js', () => ({ getRecordByWebContentsId: () => undefined }))
vi.mock('./settings.js', () => ({ getAssetSettings: () => ({}), updateAssetSettings: () => ({}) }))
vi.mock('../shared/broadcast.js', () => ({ broadcastToAllWindows: () => {} }))
vi.mock('../ai/handler.js', () => ({ hasActiveAssetStreams: () => state.busy }))

import { OriginalVault } from './original-vault'
import { dialog, shell } from 'electron'
import { registerAiAssetIpc, hasWebOriginalTransfers, closeAssetCollectionJournal } from './asset-ipc'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels'

const bytes = Buffer.from('verified original')
const input = { externalKey: 'message:file', conversationKey: 'https://fixture.test/chat/a', direction: 'input', name: 'original.bin' }
const observation = { conversationKey: input.conversationKey, messages: [{ key: 'u1', role: 'user', content: 'Fixture message' }] }
let guest: EventEmitter & { id: number; mainFrame: object; session: object }
let guestEvent: any
let viewerEvent: any
let vault: OriginalVault
const call = (channel: string, event: any, ...args: unknown[]) => state.handlers.get(channel)!(event, ...args)

beforeEach(async () => {
  await mkdir(path.resolve('build'), { recursive: true })
  state.root = await mkdtemp(path.resolve('build/asset-ipc-test-'))
  state.enabled = true; state.observeError = undefined; state.messages = []; state.destination = undefined
  state.temporaryRoot = undefined
  state.excluded = false; state.busy = false
  state.handlers.clear(); state.observers = []
  vi.mocked(shell.showItemInFolder).mockClear()
  guest = Object.assign(new EventEmitter(), { id: 8, mainFrame: {}, session: state.session, isDestroyed: () => false })
  state.guest = guest
  guestEvent = { sender: guest, senderFrame: guest.mainFrame }
  const frame = {}
  viewerEvent = { sender: { mainFrame: frame, getType: () => 'window', getURL: () => 'file:///fixture/index.html' }, senderFrame: frame }
  vault = new OriginalVault(path.join(state.root, 'ai-assets'), path.join(state.root, '.ai-assets-pending'))
  await vault.begin('file-a'); await vault.append('file-a', 0, bytes)
  const original = await vault.finish('file-a', bytes.length)
  state.record = { id: 'file-a', sourceId: 'profile-a', status: 'saved', name: 'original.bin', ...original }
  registerAiAssetIpc()
})
afterEach(async () => {
  vi.useRealTimers()
  state.enabled = false; for (const observer of state.observers) observer()
  closeAssetCollectionJournal()
  for (let attempt = 0; hasWebOriginalTransfers() && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  if (path.dirname(state.root) !== path.resolve('build') || !path.basename(state.root).startsWith('asset-ipc-test-')) throw new Error('Unexpected fixture path')
  await rm(state.root, { recursive: true, force: true })
})

describe('asset original admission and recovery', () => {
  it('reveals a named independent copy of a historical digest object', async () => {
    state.record.name = 'report.pdf'
    state.record.mimeType = 'application/pdf'
    expect(await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).toEqual({ ok: true })
    const revealed = vi.mocked(shell.showItemInFolder).mock.calls.at(-1)![0]
    expect(path.basename(revealed)).toBe('report.pdf')
    expect(revealed).not.toBe(vault.pathFor(state.record.sha256))
    expect(await readFile(revealed)).toEqual(bytes)
    await writeFile(revealed, 'edited copy')
    await vault.verify(state.record.sha256, bytes.length)
    expect(await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).toEqual({ ok: true })
    const next = vi.mocked(shell.showItemInFolder).mock.calls.at(-1)![0]
    expect(next).not.toBe(revealed)
    expect(await readFile(next)).toEqual(bytes)
    expect(await readFile(revealed, 'utf8')).toBe('edited copy')
  })
  it('keeps a healthy original when the temporary copy cannot be created', async () => {
    state.temporaryRoot = path.join(state.root, 'missing')
    expect(await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).toMatchObject({ ok: false, error: expect.stringContaining('副本') })
    expect(state.record.status).toBe('saved')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    await vault.verify(state.record.sha256, bytes.length)
  })
  it('uses the same safe extension for export and folder access without changing the saved name', async () => {
    state.record.name = 'C:\\private\\report'
    state.record.mimeType = 'application/pdf'
    const save = vi.spyOn(dialog, 'showSaveDialog')
    try {
      expect(await call(ipc.ASSET_ATTACHMENT_EXPORT, viewerEvent, 'file-a')).toEqual({ ok: false, canceled: true })
      expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ defaultPath: 'report.pdf' }))
      expect(await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).toEqual({ ok: true })
      expect(path.basename(vi.mocked(shell.showItemInFolder).mock.calls.at(-1)![0])).toBe('report.pdf')
      expect(state.record.name).toBe('C:\\private\\report')
    } finally { save.mockRestore() }
  })
  it('rejects file access from a webpage or child frame', async () => {
    for (const event of [guestEvent, { ...viewerEvent, senderFrame: {} }]) {
      await expect(call(ipc.ASSET_ATTACHMENT_OPEN, event, 'file-a')).rejects.toThrow()
      await expect(call(ipc.ASSET_ATTACHMENT_EXPORT, event, 'file-a')).rejects.toThrow()
    }
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
  it('does not retry originals excluded by selected cleanup', async () => {
    state.excluded = true
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ suppressed: true })
    expect(hasWebOriginalTransfers()).toBe(false)
  })
  it('rejects guest deletion, malformed selections and deletion during recording', async () => {
    await expect(call(ipc.ASSET_DELETE_SELECTION, guestEvent, 'files', ['file-a'])).rejects.toThrow()
    for (const ids of [[], ['file-a', 'file-a'], ['file-a', 1], ['']])
      await expect(call(ipc.ASSET_DELETE_SELECTION, viewerEvent, 'files', ids)).rejects.toThrow('Invalid asset selection')
    state.busy = true
    await expect(call(ipc.ASSET_DELETE_SELECTION, viewerEvent, 'files', ['file-a'])).rejects.toThrow()
    expect(state.record.status).toBe('saved')
  })
  it('suppresses automatic output originals without starting a transfer', async () => {
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, { ...input, direction: 'output' })).toEqual({ suppressed: true })
    expect(hasWebOriginalTransfers()).toBe(false)
    expect(state.record.status).toBe('saved')
  })
  it('reuses only an existing verified object', async () => {
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', saved: true })
    expect(hasWebOriginalTransfers()).toBe(false)
  })
  it('restores missing size metadata from the verified object', async () => {
    delete state.record.size
    expect((await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).saved).toBe(true)
    expect(state.record.size).toBe(bytes.length)
  })
  it('does not admit a transfer after the module is disabled during verification', async () => {
    const pending = call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    state.enabled = false
    for (const observer of state.observers) observer()
    await expect(pending).rejects.toThrow()
    expect(state.record.status).toBe('failed')
    expect(hasWebOriginalTransfers()).toBe(false)
  })
  it('cancels admission when the owning guest closes', async () => {
    const pending = call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    guest.emit('destroyed')
    await expect(pending).rejects.toThrow()
    expect(state.record.status).toBe('failed')
    expect(hasWebOriginalTransfers()).toBe(false)
  })
  it('keeps an original during an in-page route and cancels it on document navigation', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    guest.emit('did-start-navigation', {}, 'https://fixture.test/other', true, true)
    expect(hasWebOriginalTransfers()).toBe(true)
    guest.emit('did-start-navigation', {}, 'https://fixture.test/reloaded', false, true)
    await vi.waitFor(() => expect(hasWebOriginalTransfers()).toBe(false))
    expect(state.record.status).toBe('failed')
    expect(await readdir(path.join(state.root, '.ai-assets-pending'))).toEqual([])
  })
  it('does not cancel a replacement when retired admission completes late', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let first = true
    const begin = OriginalVault.prototype.begin
    const delayed = vi.spyOn(OriginalVault.prototype, 'begin').mockImplementation(async function (this: OriginalVault, id) {
      await begin.call(this, id)
      if (first) { first = false; entered(); await gate }
    })
    const retired = call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input).then(() => false, () => true)
    try {
      await waiting
      state.enabled = false; for (const observer of state.observers) observer()
      await vi.waitFor(() => expect(hasWebOriginalTransfers()).toBe(false))
      state.enabled = true; for (const observer of state.observers) observer()
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toMatchObject({ id: 'file-a', saved: false })
      release()
      expect(await retired).toBe(true)
      expect(state.record.status).toBe('pending')
      expect(hasWebOriginalTransfers()).toBe(true)
      await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
      await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)
      await vault.verify(state.record.sha256, bytes.length)
      expect(await readdir(path.join(state.root, '.ai-assets-pending'))).toHaveLength(0)
    } finally { release(); delayed.mockRestore(); await retired }
  })
  it('does not abort a replacement when retired finalization completes late', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let first = true
    const finish = OriginalVault.prototype.finish
    const delayed = vi.spyOn(OriginalVault.prototype, 'finish').mockImplementation(async function (this: OriginalVault, ...args) {
      const result = await finish.apply(this, args)
      if (first) { first = false; entered(); await gate }
      return result
    })
    const retired = call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length).then(() => false, () => true)
    try {
      await waiting
      state.enabled = false; for (const observer of state.observers) observer()
      await vi.waitFor(() => expect(hasWebOriginalTransfers()).toBe(false))
      await unlink(vault.pathFor(state.record.sha256))
      state.enabled = true; for (const observer of state.observers) observer()
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toMatchObject({ id: 'file-a', saved: false })
      release()
      expect(await retired).toBe(true)
      expect(state.record.status).toBe('pending')
      expect(hasWebOriginalTransfers()).toBe(true)
      await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
      await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)
      await vault.verify(state.record.sha256, bytes.length)
      expect(await readdir(path.join(state.root, '.ai-assets-pending'))).toHaveLength(0)
    } finally { release(); delayed.mockRestore(); await retired }
  })
  it('does not append to or abort a replacement after a retired fetch returns late', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }))
    const fetcher = vi.fn(async () => response)
    Object.assign(state.session, { fetch: fetcher })
    state.record.sourceUrl = 'https://fixture.test/file.bin'
    const retired = call(ipc.ASSET_ATTACHMENT_FETCH, guestEvent, 'file-a')
    try {
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      state.enabled = false; for (const observer of state.observers) observer()
      await vi.waitFor(() => expect(hasWebOriginalTransfers()).toBe(false))
      state.enabled = true; for (const observer of state.observers) observer()
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toMatchObject({ id: 'file-a', saved: false })
      stream.enqueue(bytes); stream.close()
      expect((await retired).ok).toBe(false)
      expect(state.record.status).toBe('pending')
      expect(hasWebOriginalTransfers()).toBe(true)
      await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
      await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)
      await vault.verify(state.record.sha256, bytes.length)
      expect(await readdir(path.join(state.root, '.ai-assets-pending'))).toHaveLength(0)
    } finally {
      try { stream.close() } catch {}
      delete (state.session as { fetch?: unknown }).fetch
      await retired
    }
  })
  it('starts collection again when the saved object is missing', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toMatchObject({ id: 'file-a', saved: false })
    expect(state.record.status).toBe('pending')
    await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
    expect(await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)).toEqual({ ok: true })
    expect(await vault.verify(state.record.sha256, bytes.length)).toBe(vault.pathFor(state.record.sha256))
  })
  it('marks a corrupt object as failed when opening it', async () => {
    await writeFile(vault.pathFor(state.record.sha256), Buffer.alloc(bytes.length, 120))
    expect((await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).ok).toBe(false)
    expect(state.record.status).toBe('failed')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
    expect(state.messages.some(([channel]) => channel === ipc.CHAT_CONVERSATION_PERSISTED)).toBe(true)
  })
  it('marks a missing object as failed before offering export', async () => {
    await unlink(vault.pathFor(state.record.sha256))
    expect((await call(ipc.ASSET_ATTACHMENT_EXPORT, viewerEvent, 'file-a')).ok).toBe(false)
    expect(state.record.status).toBe('failed')
  })
  it('does not mark a good original as damaged when the export destination fails', async () => {
    state.destination = path.join(state.root, 'missing-directory', 'export.bin')
    expect((await call(ipc.ASSET_ATTACHMENT_EXPORT, viewerEvent, 'file-a')).ok).toBe(false)
    expect(state.record.status).toBe('saved')
  })
  it('preserves a corrupt object while replacing it with verified original bytes', async () => {
    const originalHash = state.record.sha256
    await writeFile(vault.pathFor(originalHash), Buffer.alloc(bytes.length, 120))
    expect((await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).saved).toBe(false)
    await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
    await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)
    expect(state.record.sha256).toBe(originalHash)
    await vault.verify(originalHash, bytes.length)
    expect(await readdir(path.join(state.root, 'ai-assets', 'quarantine'))).toHaveLength(1)
  })
  it('rejects changed bytes when recovering a known original', async () => {
    const originalHash = state.record.sha256
    await unlink(vault.pathFor(originalHash))
    await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    const changed = Buffer.from('different original')
    await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, changed)
    await expect(call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', changed.length)).rejects.toThrow('digest')
    expect(state.record.status).toBe('failed')
    expect(state.record.sha256).toBe(originalHash)
  })
  it('rejects a second transfer while checking the first saved reference', async () => {
    const first = call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', busy: true })
    await first
  })
})

describe('collection failure visibility', () => {
  it('does not focus a page when the requested profile differs from its actual session', () => {
    expect(call(ipc.ASSET_AUTHORIZE, guestEvent)).toBe(true)
    expect(call(ipc.ASSET_FOCUS_PAGE, viewerEvent, guest.id, 'different-profile')).toBe(false)
    for (const profile of ['', 1, 'x'.repeat(129)])
      expect(() => call(ipc.ASSET_FOCUS_PAGE, viewerEvent, guest.id, profile)).toThrow('Invalid AI asset profile')
  })
  it('durably accepts a failed store write and clears its issue after replay', async () => {
    vi.useFakeTimers()
    state.observeError = new Error('Private database path')
    expect(call(ipc.ASSET_OBSERVE, guestEvent, observation)).toMatchObject({ durable: true })
    await vi.advanceTimersByTimeAsync(0)
    const issues = call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)
    expect(issues).toEqual([expect.objectContaining({ webContentsId: 8, profileId: 'profile-a', profileName: 'Account A', failures: 1 })])
    expect(JSON.stringify(issues)).not.toContain('Private database path')
    state.observeError = undefined
    await vi.advanceTimersByTimeAsync(1000)
    expect(call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)).toEqual([])
  })
  it('retains accepted pending observations after the source page closes', async () => {
    vi.useFakeTimers()
    state.observeError = new Error('Temporary failure')
    expect(call(ipc.ASSET_OBSERVE, guestEvent, observation)).toMatchObject({ durable: true })
    await vi.advanceTimersByTimeAsync(0)
    guest.emit('destroyed')
    expect(call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)).toMatchObject([{ pendingObservations: 1 }])
  })
  it('does not expose issues or accept observations from an unrelated frame', () => {
    const child = { ...guestEvent, senderFrame: {} }
    expect(() => call(ipc.ASSET_OBSERVE, child, observation)).toThrow('not authorized')
    expect(() => call(ipc.ASSET_COLLECTION_ISSUES, guestEvent)).toThrow()
  })
})


describe('asset external links', () => {
  it('opens web links without registering the optional browser module', async () => {
    await expect(call('ai-assets:openExternal', viewerEvent, 'https://example.test/path')).resolves.toBeUndefined()
  })
  it('rejects web guests and non-web schemes', () => {
    expect(() => call('ai-assets:openExternal', guestEvent, 'https://example.test')).toThrow()
    for (const url of ['file:///C:/private', 'javascript:alert(1)', 'data:text/html,hello', 'invalid']) {
      expect(() => call('ai-assets:openExternal', viewerEvent, url)).toThrow()
    }
  })
})
