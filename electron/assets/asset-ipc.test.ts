import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const state = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (...args: any[]) => any>(), enabled: true,
  observers: [] as Array<() => void>, session: {}, record: undefined as any,
  observeError: undefined as Error | undefined, messages: [] as Array<[string, unknown]>,
  destination: undefined as string | undefined,
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, data: unknown) => state.messages.push([channel, data]) } }], fromWebContents: () => ({}) },
  clipboard: {}, dialog: { showSaveDialog: async () => state.destination ? { canceled: false, filePath: state.destination } : { canceled: true } },
  shell: { showItemInFolder: vi.fn() }, net: { fetch: vi.fn() },
  ipcMain: { handle: (channel: string, callback: (...args: any[]) => any) => state.handlers.set(channel, callback) },
  session: { fromPartition: () => state.session }, webContents: { getAllWebContents: () => [] },
}))
vi.mock('../store/chat-store.js', () => ({
  getChatStore: () => ({
    cleanupInvalidConversations: () => {},
    assets: {
      observe: () => { if (state.observeError) throw state.observeError; return { conversationId: 'conversation-a' } },
      beginAttachment: () => state.record,
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

import { OriginalVault } from './original-vault'
import { registerAiAssetIpc, hasWebOriginalTransfers } from './asset-ipc'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels'

const bytes = Buffer.from('verified original')
const input = { externalKey: 'message:file', conversationKey: 'https://fixture.test/chat/a', direction: 'output', name: 'original.bin' }
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
  state.handlers.clear(); state.observers = []
  guest = Object.assign(new EventEmitter(), { id: 8, mainFrame: {}, session: state.session })
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
  state.enabled = false; for (const observer of state.observers) observer()
  for (let attempt = 0; hasWebOriginalTransfers() && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  if (path.dirname(state.root) !== path.resolve('build') || !path.basename(state.root).startsWith('asset-ipc-test-')) throw new Error('Unexpected fixture path')
  await rm(state.root, { recursive: true, force: true })
})

describe('asset original admission and recovery', () => {
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
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', saved: false })
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
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', saved: false })
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
      expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', saved: false })
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
    expect(await call(ipc.ASSET_ATTACHMENT_BEGIN, guestEvent, input)).toEqual({ id: 'file-a', saved: false })
    expect(state.record.status).toBe('pending')
    await call(ipc.ASSET_ATTACHMENT_CHUNK, guestEvent, 'file-a', 0, bytes)
    expect(await call(ipc.ASSET_ATTACHMENT_FINISH, guestEvent, 'file-a', bytes.length)).toEqual({ ok: true })
    expect(await vault.verify(state.record.sha256, bytes.length)).toBe(vault.pathFor(state.record.sha256))
  })
  it('marks a corrupt object as failed when opening it', async () => {
    await writeFile(vault.pathFor(state.record.sha256), Buffer.alloc(bytes.length, 120))
    expect((await call(ipc.ASSET_ATTACHMENT_OPEN, viewerEvent, 'file-a')).ok).toBe(false)
    expect(state.record.status).toBe('failed')
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
  it('reports only the authorized account and clears its issue after success', () => {
    state.observeError = new Error('Private database path')
    expect(() => call(ipc.ASSET_OBSERVE, guestEvent, observation)).toThrow('Private database path')
    const issues = call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)
    expect(issues).toEqual([expect.objectContaining({ webContentsId: 8, profileId: 'profile-a', profileName: 'Account A', failures: 1 })])
    expect(JSON.stringify(issues)).not.toContain('Private database path')
    state.observeError = undefined
    call(ipc.ASSET_OBSERVE, guestEvent, observation)
    expect(call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)).toEqual([])
  })
  it('removes pending issue state when the source closes', () => {
    state.observeError = new Error('Temporary failure')
    expect(() => call(ipc.ASSET_OBSERVE, guestEvent, observation)).toThrow()
    guest.emit('destroyed')
    expect(call(ipc.ASSET_COLLECTION_ISSUES, viewerEvent)).toEqual([])
  })
  it('does not expose issues or accept observations from an unrelated frame', () => {
    const child = { ...guestEvent, senderFrame: {} }
    expect(() => call(ipc.ASSET_OBSERVE, child, observation)).toThrow('not authorized')
    expect(() => call(ipc.ASSET_COLLECTION_ISSUES, guestEvent)).toThrow()
  })
})
