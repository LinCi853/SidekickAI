import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { AiAssetsStore } from './ai-assets-store'
import type { AssetObservation } from '../shared/ai-assets.types'

describe('MiMo inferred message identity', () => {
  let db: Database.Database
  let store: AiAssetsStore
  const source = { id: 'mimo-profile', type: 'webview' as const }
  const observation = (content: string, identityToken: string, status: 'streaming' | 'complete' = 'complete'): AssetObservation => ({
    title: 'MiMo', conversationKey: 'https://aistudio.xiaomimimo.com/#/chat/one',
    url: 'https://aistudio.xiaomimimo.com/#/chat/one', snapshot: true, completePath: false,
    messages: [{ key: 'user:mimo:prompt:0', role: 'user', content: 'Same prompt', identityToken },
      { key: 'assistant:mimo:prompt:0', role: 'assistant', content, identityToken, status }],
  })
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, url TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, auto_grabbed INTEGER, content_hash TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);`)
    store = new AiAssetsStore(db)
  })
  afterEach(() => db.close())
  it('retains a complete reply when a new document reuses an inferred key for another answer', () => {
    const first = store.observe(source, observation('Latest answer', 'original-element'))
    const usage = store.usage()
    const reloaded = new AiAssetsStore(db)
    const next = reloaded.observe(source, observation('Earlier answer', 'other-element'))
    expect(next.conversationId).toBe(first.conversationId)
    expect(next.messageIds).toEqual({})
    expect(db.prepare('SELECT content FROM messages ORDER BY rowid').all()).toEqual([{ content: 'Same prompt' }, { content: 'Latest answer' }])
    expect(reloaded.usage()).toEqual(usage)
    expect(reloaded.details(first.conversationId).every(detail => !detail.revisions.length)).toBe(true)
  })
  it('accepts unchanged reloaded messages and a later update of that confirmed element', () => {
    const first = store.observe(source, observation('Answer', 'first-element'))
    const reloaded = new AiAssetsStore(db)
    const repeat = reloaded.observe(source, observation('Answer', 'reloaded-element'))
    expect(repeat.messageIds).toEqual(first.messageIds)
    const edited = observation('Revised answer', 'reloaded-element')
    edited.messages[0].content = 'Edited prompt'
    reloaded.observe(source, edited)
    expect(db.prepare('SELECT content FROM messages ORDER BY rowid').all()).toEqual([{ content: 'Edited prompt' }, { content: 'Revised answer' }])
    expect(reloaded.details(first.conversationId).every(detail => detail.revisions.length === 1)).toBe(true)
  })
  it('continues a retained interrupted stream across a new document', () => {
    const first = store.observe(source, observation('Answer', 'first-element', 'streaming'))
    const reloaded = new AiAssetsStore(db)
    reloaded.recoverInterruptedStreams()
    reloaded.observe(source, observation('Answer continued', 'reloaded-element'))
    expect(reloaded.details(first.conversationId)[1].status).toBe('complete')
    expect(db.prepare('SELECT content FROM messages WHERE role = ?').get('assistant')).toEqual({ content: 'Answer continued' })
    expect(reloaded.usage().outputCharacters).toBe('Answer continued'.length)
  })
  it('rejects conflicting tokens for the same inferred message key in one snapshot', () => {
    const first = store.observe(source, observation('Answer', 'first-element'))
    const duplicate = observation('Answer', 'first-element')
    duplicate.messages.push(...observation('Answer', 'other-element').messages)
    expect(store.observe(source, duplicate).messageIds).toEqual({})
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 2 })
    expect(store.details(first.conversationId).every(detail => !detail.revisions.length)).toBe(true)
  })
})
