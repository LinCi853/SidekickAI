import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssetAttachment } from '../shared/ai-assets.types'

const state = vi.hoisted(() => ({ root: '', record: undefined as unknown as AssetAttachment, notifications: 0 }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, net: { fetch: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: () => state.notifications++ } }] } }))
vi.mock('../modules/registry.js', () => ({ isModuleEnabled: () => true }))
vi.mock('../store/chat-store.js', () => ({ getChatStore: () => ({ assets: {
  beginAttachment: () => state.record,
  attachmentPending: () => { state.record.status = 'pending' },
  attachmentFailed: (_id: string, error: string) => { Object.assign(state.record, { status: 'failed', error }) },
  attachmentSaved: (_id: string, sha256: string, size: number, reused: boolean) => {
    Object.assign(state.record, { status: reused ? 'reused' : 'saved', sha256, size, error: undefined })
  },
} }) }))
import { acquireLinkedOriginal, hasLinkedOriginalTransfers, stopLinkedOriginalTransfers } from './api-originals'
import { OriginalVault } from './original-vault'

const bytes = Buffer.from('linked original')
let vault: OriginalVault
beforeEach(async () => {
  await mkdir(path.resolve('build'), { recursive: true })
  state.root = await mkdtemp(path.resolve('build/linked-original-test-'))
  state.notifications = 0
  vault = new OriginalVault(path.join(state.root, 'ai-assets'), path.join(state.root, '.ai-assets-pending'))
  await vault.begin('a'); await vault.append('a', 0, bytes)
  const original = await vault.finish('a', bytes.length)
  state.record = { id: 'a', conversationId: 'conversation-a', sourceId: 'profile-a', sourceType: 'api',
    direction: 'output', name: 'file.pdf', mimeType: 'application/pdf', sourceUrl: 'https://fixture.test/file.pdf',
    status: 'saved', createdAt: 1, ...original } as AssetAttachment
})
afterEach(async () => {
  stopLinkedOriginalTransfers()
  expect(hasLinkedOriginalTransfers()).toBe(false)
  if (path.dirname(state.root) !== path.resolve('build') || !path.basename(state.root).startsWith('linked-original-test-')) throw new Error('Unexpected fixture path')
  await rm(state.root, { recursive: true, force: true })
})
describe('linked original recovery', () => {
  it('verifies a historical reference when explicitly retried', async () => {
    await unlink(vault.pathFor(state.record.sha256!))
    const { net } = await import('electron')
    vi.mocked(net.fetch).mockResolvedValueOnce(new Response(bytes))
    await acquireLinkedOriginal(state.record)
    expect(state.record.status).toBe('saved')
    expect(await vault.verify(state.record.sha256!, bytes.length)).toBeTruthy()
  })
  it('recovers damaged known originals while preserving the bad object', async () => {
    const hash = state.record.sha256!
    await writeFile(vault.pathFor(hash), 'damaged bytes')
    await acquireLinkedOriginal(state.record, vi.fn(async () => new Response(bytes)))
    expect(state.record.status).toBe('saved')
    expect(state.record.sha256).toBe(hash)
    await vault.verify(hash, bytes.length)
    expect(await readdir(path.join(state.root, 'ai-assets', 'quarantine'))).toHaveLength(1)
  })
  it('rejects a changed source and retains the original reference hash', async () => {
    const hash = state.record.sha256!
    await unlink(vault.pathFor(hash))
    await acquireLinkedOriginal(state.record, vi.fn(async () => new Response('changed content')))
    expect(state.record.status).toBe('failed')
    expect(state.record.sha256).toBe(hash)
    await expect(vault.verify(hash)).rejects.toThrow()
    expect(await readdir(path.join(state.root, '.ai-assets-pending'))).toHaveLength(0)
  })
  it('reuses a verified zero byte object without inventing missing metadata', async () => {
    await vault.begin('empty')
    const empty = await vault.finish('empty', 0)
    state.record.sha256 = empty.sha256; delete state.record.size
    const fetcher = vi.fn()
    await acquireLinkedOriginal(state.record, fetcher)
    expect(state.record.size).toBe(0)
    expect(state.record.status).toBe('reused')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cancels before retrieval when disabled during saved-object verification', async () => {
    const fetcher = vi.fn()
    const operation = acquireLinkedOriginal(state.record, fetcher)
    stopLinkedOriginalTransfers()
    await operation
    expect(state.record.status).toBe('failed')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
