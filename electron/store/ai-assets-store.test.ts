import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { AiAssetsStore } from './ai-assets-store'

describe('AI asset collection', () => {
  let db: Database.Database
  let store: AiAssetsStore
  const source = { id: 'account-a', type: 'webview' as const }
  const observe = (content: string, status: 'streaming' | 'complete' | 'withdrawn' = 'streaming', key = 'assistant:0') =>
    store.observe(source, { conversationKey: '/conversation/1', title: 'Conversation', messages: [{ key, role: 'assistant', content, status }] })
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, url TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, auto_grabbed INTEGER, content_hash TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);`)
    store = new AiAssetsStore(db)
  })
  afterEach(() => db.close())
  it('keeps short and long replies, stream withdrawal and independent identical turns', () => {
    const { conversationId } = observe('好')
    observe('好'.repeat(12000)); observe('', 'withdrawn'); observe('', 'withdrawn')
    observe('好', 'complete', 'assistant:1')
    const details = store.details(conversationId)
    expect(details).toHaveLength(2)
    expect(details[0].revisions.at(-1)?.content).toHaveLength(12000)
    expect(details[0].status).toBe('withdrawn')
    expect(store.usage().outputCharacters).toBe(12001)
  })
  it('does not count repeated observations or count returned token fields', () => {
    observe('😀 A'); observe('😀 A'); observe('😀 A', 'complete')
    expect(store.usage().totalCharacters).toBe(3)
  })
  it('restores an unchanged visible message after withdrawal without counting its content twice', () => {
    const { conversationId } = observe('answer', 'complete')
    observe('', 'withdrawn'); observe('answer', 'complete')
    expect(store.details(conversationId)[0].status).toBe('complete')
    expect(store.usage().outputCharacters).toBe(6)
  })
  it('isolates accounts and conversations and persists reasoning and revisions', () => {
    const original = observe('answer')
    store.observe(source, { conversationKey: '/conversation/1', title: 'Conversation', messages: [{ key: 'assistant:0', role: 'assistant', content: 'new', reasoning: '思考 😀', status: 'complete' }] })
    store.observe({ id: 'account-b', type: 'webview' }, { conversationKey: '/conversation/1', title: 'Other account', messages: [{ key: 'assistant:0', role: 'assistant', content: 'answer' }] })
    expect(db.prepare('SELECT * FROM conversations').all()).toHaveLength(2)
    const detail = store.details(original.conversationId)[0]
    expect(detail.reasoningCharacters).toBe(4)
    expect(detail.revisions[0].content).toBe('answer')
  })
  it('keeps identity when a draft URL becomes a stable conversation URL', () => {
    const message = { key: 'user:platform-id', role: 'user' as const, content: 'same input' }
    const original = store.observe(source, { conversationKey: 'document:draft', title: 'Draft', messages: [message] })
    const stable = store.observe(source, { conversationKey: '/conversation/created', previousConversationKey: 'document:draft', title: 'Created', messages: [message] })
    expect(stable.conversationId).toBe(original.conversationId)
    expect(store.usage().inputCharacters).toBe(10)
    const other = store.observe(source, { conversationKey: '/conversation/other', previousConversationKey: '/conversation/created', title: 'Other', messages: [message] })
    expect(other.conversationId).not.toBe(original.conversationId)
  })
  it('keeps attachment references unique and exposes failed acquisition honestly', () => {
    const input = { conversationKey: '1', title: 'Files', externalKey: 'a', name: 'a.png', mimeType: 'image/png', direction: 'input' as const }
    const first = store.beginAttachment(source, input)
    expect(store.beginAttachment(source, input).id).toBe(first.id)
    store.attachmentFailed(first.id, 'Offline')
    expect(store.attachments()[0]).toMatchObject({ status: 'failed', error: 'Offline' })
    store.attachmentSaved(first.id, 'a'.repeat(64), 100, false)
    expect(store.attachments()[0]).toMatchObject({ status: 'saved', sha256: 'a'.repeat(64) })
  })
  it('recovers interrupted received text without discarding or recounting it', () => {
    const { conversationId } = observe('received output')
    const usage = store.usage()
    store.recoverInterruptedStreams()
    expect(store.details(conversationId)[0].status).toBe('stopped')
    expect(store.usage()).toEqual(usage)
    observe('received output', 'complete')
    expect(store.usage()).toEqual(usage)
  })
})
