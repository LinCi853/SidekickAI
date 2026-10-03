import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
import { ChatStore } from '../store/chat-store'
import { cleanSelectedAttachments, recoverSelectedCleanup } from './selected-cleanup'

let root: string, store: ChatStore
const source = { id: 'account', type: 'webview' as const }
const input = (key: string) => ({ conversationKey: `conversation-${key}`, title: key, name: `${key}.txt`, mimeType: 'text/plain', externalKey: key, direction: 'input' as const })
function original(key: string, content = 'shared bytes') {
  const item = store.assets.beginAttachment(source, input(key))
  const hash = createHash('sha256').update(content).digest('hex')
  const file = path.join(root, 'ai-assets', 'objects', hash.slice(0, 2), hash)
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
  store.assets.attachmentSaved(item.id, hash, Buffer.byteLength(content), false)
  return { item, hash, file }
}
beforeEach(() => {
  fs.mkdirSync(path.resolve('build'), { recursive: true }); root = fs.mkdtempSync(path.resolve('build/selected-cleanup-test-'))
  store = new ChatStore(':memory:')
})
afterEach(() => {
  store.close(); vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('selected-cleanup-test-')) throw new Error('Unexpected fixture root')
  fs.rmSync(root, { recursive: true, force: true })
})
describe('selected asset cleanup', () => {
  it('retains a shared object until its last selected reference is removed', () => {
    const first = original('first'), second = original('second')
    expect(cleanSelectedAttachments(root, store.assets, [first.item.id])).toEqual({ deleted: 1, cleanupPending: false })
    expect(fs.existsSync(first.file)).toBe(true)
    expect(store.assets.attachments()).toHaveLength(1)
    expect(store.assets.attachmentExcluded(source.id, 'first')).toBe(true)
    expect(() => store.assets.beginAttachment(source, input('first'))).toThrow()
    expect(store.listConversations()).toHaveLength(2)
    cleanSelectedAttachments(root, store.assets, [second.item.id])
    expect(fs.existsSync(first.file)).toBe(false)
    expect(store.assets.attachments()).toEqual([])
  })
  it('removes an unreferenced object once when all its references are selected together', () => {
    const first = original('first'), second = original('second')
    expect(cleanSelectedAttachments(root, store.assets, [first.item.id, second.item.id]).deleted).toBe(2)
    expect(fs.existsSync(first.file)).toBe(false)
    expect(fs.existsSync(path.join(root, 'ai-assets', '.selected-cleanup'))).toBe(false)
  })
  it('rejects stale selections before changing any row or object', () => {
    const first = original('first')
    expect(() => cleanSelectedAttachments(root, store.assets, [first.item.id, 'missing'])).toThrow()
    expect(fs.existsSync(first.file)).toBe(true)
    expect(store.assets.getAttachment(first.item.id)).toBeDefined()
  })
  it('restores originals and references on a database failure after staging', () => {
    const first = original('first')
    const db = (store.assets as any).db
    db.exec("CREATE TRIGGER prevent_attachment_delete BEFORE DELETE ON asset_attachments BEGIN SELECT RAISE(ABORT, 'Fixture SQL failure'); END")
    expect(() => cleanSelectedAttachments(root, store.assets, [first.item.id])).toThrow('Fixture SQL failure')
    expect(fs.readFileSync(first.file, 'utf8')).toBe('shared bytes')
    expect(store.assets.getAttachment(first.item.id)).toBeDefined()
    expect(store.assets.attachmentExcluded(source.id, 'first')).toBe(false)
  })
  it('restores earlier moves when a later file move fails', () => {
    const first = original('first'), second = original('second', 'different bytes')
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === second.file) throw new Error('Fixture file lock')
      return rename(from, to)
    })
    expect(() => cleanSelectedAttachments(root, store.assets, [first.item.id, second.item.id])).toThrow('Fixture file lock')
    expect(fs.existsSync(first.file) && fs.existsSync(second.file)).toBe(true)
    expect(store.assets.attachments()).toHaveLength(2)
  })
  it('reports incomplete post-commit cleanup and recovers it on retry', () => {
    const first = original('first')
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('Fixture file lock') })
    expect(cleanSelectedAttachments(root, store.assets, [first.item.id])).toEqual({ deleted: 1, cleanupPending: true })
    expect(store.assets.getAttachment(first.item.id)).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'ai-assets', '.selected-cleanup', first.hash))).toBe(true)
    recoverSelectedCleanup(root, store.assets)
    expect(fs.existsSync(path.join(root, 'ai-assets', '.selected-cleanup'))).toBe(false)
  })
  it('restores an interrupted pre-commit move using surviving database references', () => {
    const first = original('first'), staging = path.join(root, 'ai-assets', '.selected-cleanup')
    fs.mkdirSync(staging); fs.renameSync(first.file, path.join(staging, first.hash))
    recoverSelectedCleanup(root, store.assets)
    expect(fs.readFileSync(first.file, 'utf8')).toBe('shared bytes')
    expect(store.assets.getAttachment(first.item.id)).toBeDefined()
  })
  it('retains a verified object reacquired after an interrupted cleanup', () => {
    const first = original('first'), staging = path.join(root, 'ai-assets', '.selected-cleanup')
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('Fixture file lock') })
    cleanSelectedAttachments(root, store.assets, [first.item.id])
    const replacement = original('replacement')
    recoverSelectedCleanup(root, store.assets)
    expect(fs.readFileSync(replacement.file, 'utf8')).toBe('shared bytes')
    expect(store.assets.getAttachment(replacement.item.id)).toBeDefined()
    expect(fs.existsSync(staging)).toBe(false)
  })
  it('does not follow an object directory junction', () => {
    const first = original('first'), prefix = path.dirname(first.file)
    const outside = path.join(root, 'other'); fs.mkdirSync(outside)
    fs.renameSync(first.file, path.join(outside, first.hash)); fs.rmdirSync(prefix)
    fs.symlinkSync(outside, prefix, 'junction')
    expect(() => cleanSelectedAttachments(root, store.assets, [first.item.id])).toThrow()
    expect(fs.readFileSync(path.join(outside, first.hash), 'utf8')).toBe('shared bytes')
    expect(store.assets.getAttachment(first.item.id)).toBeDefined()
  })
  it('cleans records with unavailable originals without touching unrelated files', () => {
    const item = store.assets.beginAttachment(source, input('pending'))
    fs.writeFileSync(path.join(root, 'notes.txt'), 'keep')
    expect(cleanSelectedAttachments(root, store.assets, [item.id]).deleted).toBe(1)
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('keep')
  })
  it('applies conversation selection atomically while retaining original bytes', () => {
    const first = original('first'), second = original('second')
    expect(() => store.assets.deleteConversations([first.item.conversationId, 'missing'])).toThrow()
    expect(store.listConversations()).toHaveLength(2)
    expect(store.assets.deleteConversations([first.item.conversationId, second.item.conversationId])).toBe(2)
    expect(store.listConversations()).toHaveLength(0)
    expect(fs.existsSync(first.file)).toBe(true)
    expect(() => store.assets.beginAttachment(source, input('first'))).toThrow()
  })
})
