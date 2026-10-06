import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { AssetObservation, AssetSource } from '../shared/ai-assets.types.js'
import { AiAssetsStore } from '../store/ai-assets-store.js'
import { AssetObservationJournal } from './collection-journal.js'

const source: AssetSource = { id: 'profile-a', type: 'webview' }
const observation = (id: string, conversationKey: string, content: string): AssetObservation => ({
  observationId: id, conversationKey, title: 'Journal fixture', snapshot: true, completePath: true,
  messages: [{ key: 'user:u1', role: 'user', content, status: 'complete' }],
})
let root: string
let db: Database.Database
let assets: AiAssetsStore
let journal: AssetObservationJournal
let failA: boolean
let authorized: boolean
let attempts: Array<{ key: string; content: string }>
const createJournal = () => new AssetObservationJournal(path.join(root, 'asset-collection.db'), {
  authorize: () => authorized,
  observe: (profile, payload) => {
    attempts.push({ key: payload.conversationKey, content: payload.messages[0].content })
    if (failA && payload.conversationKey === '/A') throw new Error('Fixture write failure')
    return assets.observe(profile, payload)
  },
  associate: (profile, payload, externalKey, messageKey, messageId) =>
    assets.associateCapturedInput(profile, payload, externalKey, messageKey, messageId),
  changed: () => {}, committed: () => {},
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
  const buildRoot = path.resolve('build')
  mkdirSync(buildRoot, { recursive: true })
  root = mkdtempSync(path.join(buildRoot, 'observation-journal-test-'))
  db = new Database(path.join(root, 'chat.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 1')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, url TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, auto_grabbed INTEGER, content_hash TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);`)
  assets = new AiAssetsStore(db)
  attempts = []; failA = false; authorized = true
  journal = createJournal()
  journal.start()
})
afterEach(() => {
  journal.close(); db.close(); vi.useRealTimers()
  if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('observation-journal-test-')) throw new Error('Unexpected fixture directory')
  rmSync(root, { recursive: true, force: true })
})

describe('durable observation recovery', () => {
  it('keeps acknowledged identities after replay and restart without reverting newer content', () => {
    const first = observation('first', '/receipt', 'First body')
    journal.receive(source, first, 8, 'Account A'); journal.flush()
    journal.receive(source, observation('second', '/receipt', 'Current body'), 8, 'Account A'); journal.flush()
    journal.close(); journal = createJournal(); journal.start()
    expect(journal.receive(source, first, 8, 'Account A')).toEqual({ durable: true, observationId: 'first' })
    journal.flush()
    expect(attempts.map(item => item.content)).toEqual(['First body', 'Current body'])
    expect(db.prepare('SELECT content FROM messages').get()).toEqual({ content: 'Current body' })
    expect(() => journal.receive(source, observation('first', '/receipt', 'Different body'), 8, 'Account A'))
      .toThrow('identity was reused')
  })
  it('keeps every A revision while B commits and replays A after restart', () => {
    failA = true
    for (const [id, text] of [['one', 'A'], ['two', 'B'], ['three', 'A']])
      expect(journal.receive(source, observation(id, '/A', text), 8, 'Account A')).toMatchObject({ durable: true, observationId: id })
    journal.receive(source, observation('independent', '/B', 'Independent'), 8, 'Account A')
    journal.flush()
    expect(attempts.map(item => item.key)).toEqual(['/A', '/B'])
    expect(journal.issues()).toMatchObject([{ pendingObservations: 3 }])
    journal.close()
    journal = createJournal(); journal.start()
    failA = false
    vi.setSystemTime(Date.now() + 1000)
    journal.flush()
    expect(attempts.filter(item => item.key === '/A').map(item => item.content)).toEqual(['A', 'A', 'B', 'A'])
    const conversation = db.prepare('SELECT conversation_id FROM asset_conversation_keys WHERE source_id = ? AND external_key = ?').get(source.id, '/A') as { conversation_id: string }
    const detail = assets.details(conversation.conversation_id)[0]
    expect(detail.revisions.map(item => item.content)).toEqual(['A', 'B'])
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get(detail.messageId)).toEqual({ content: 'A' })
    expect(journal.issues()).toEqual([])
  })

  it('accepts complete snapshots while the separate chat database is write locked', () => {
    const lock = new Database(path.join(root, 'chat.db'))
    lock.exec('BEGIN IMMEDIATE')
    try {
      expect(journal.receive(source, { ...observation('locked', '/locked', 'Complete body'),
        messages: [{ key: 'user:u1', role: 'user', content: 'Complete body', reasoning: 'Reasoning', markdownContent: '**Complete body**', versionKey: '1' }] }, 8, 'Account A'))
        .toMatchObject({ durable: true })
      journal.flush()
      expect(journal.issues()).toMatchObject([{ pendingObservations: 1 }])
    } finally { lock.exec('ROLLBACK'); lock.close() }
    vi.setSystemTime(Date.now() + 1000)
    journal.flush()
    expect(journal.issues()).toEqual([])
    const detail = assets.details((db.prepare('SELECT id FROM conversations').get() as { id: string }).id)[0]
    expect(detail).toMatchObject({ reasoning: 'Reasoning', markdownContent: '**Complete body**' })
  })

  it('preserves draft ordering when the stable route joins its pending queue', () => {
    journal.receive(source, observation('draft', 'document:draft', 'Input'), 8, 'Account A')
    journal.receive(source, { ...observation('stable', '/stable', 'Input'), previousConversationKey: 'document:draft' }, 8, 'Account A')
    journal.flush()
    expect(attempts.map(item => item.key)).toEqual(['document:draft', '/stable'])
    expect(db.prepare('SELECT COUNT(DISTINCT conversation_id) AS count FROM asset_conversation_keys').get()).toEqual({ count: 1 })
  })

  it('keeps the first captured branch for an original whose metadata arrives after restart', () => {
    const first = { ...observation('branch-one', '/branch', 'First input'), inputAttachments: [{ externalKey: 'selected:one', messageKey: 'user:u1' }],
      messages: [{ key: 'user:u1', role: 'user' as const, content: 'First input', versionKey: '1', branchIndex: 1, branchCount: 2 }] }
    journal.receive(source, first, 8, 'Account A')
    journal.flush()
    const firstId = (db.prepare('SELECT id FROM messages').get() as { id: string }).id
    journal.receive(source, { ...first, observationId: 'branch-two', messages: [{ ...first.messages[0], content: 'Second input', versionKey: '2', branchIndex: 2 }] }, 8, 'Account A')
    journal.flush()
    journal.close(); journal = createJournal(); journal.start()
    const original = assets.beginAttachment(source, { conversationKey: '/branch', title: 'Journal fixture', name: 'file.txt', mimeType: 'text/plain', direction: 'input', externalKey: 'selected:one' })
    vi.setSystemTime(Date.now() + 1000)
    journal.flush()
    expect(assets.getAttachment(original.id)?.messageId).toBe(firstId)
    expect(journal.issues()).toEqual([])
  })

  it('does not refill an excluded conversation or deleted message from pending snapshots', () => {
    const initial = assets.observe(source, observation('initial', '/delete', 'Saved'))
    journal.receive(source, observation('pending', '/delete', 'Later'), 8, 'Account A')
    assets.deleteConversation(initial.conversationId)
    journal.flush()
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 0 })
    const retained = assets.observe(source, observation('retained', '/message', 'Saved'))
    journal.receive(source, observation('pending-message', '/message', 'Later'), 8, 'Account A')
    assets.deleteMessage(retained.messageIds!['user:u1'])
    journal.flush()
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
  })

  it('rejects unverified sources and pauses accepted replay until authorization returns', () => {
    journal.receive(source, observation('accepted', '/A', 'Saved'), 8, 'Account A')
    authorized = false
    expect(() => journal.receive(source, observation('denied', '/B', 'Denied'), 8, 'Account A')).toThrow('not authorized')
    journal.flush()
    expect(attempts).toEqual([])
    journal.pause()
    authorized = true
    journal.flush()
    expect(attempts).toEqual([])
    journal.start(); vi.setSystemTime(Date.now() + 1000); journal.flush()
    expect(attempts).toHaveLength(1)
  })

  it('requires a stopped journal for explicit clearing and cannot replay cleared data', () => {
    journal.receive(source, observation('accepted', '/A', 'Saved'), 8, 'Account A')
    expect(() => journal.clear()).toThrow('stopped')
    journal.pause(); journal.clear(); journal.close()
    journal = createJournal(); journal.start(); journal.flush()
    expect(attempts).toEqual([])
    expect(journal.receive(source, observation('accepted', '/A', 'New body'), 8, 'Account A')).toMatchObject({ durable: true })
    journal.flush()
    expect(attempts.map(item => item.content)).toEqual(['New body'])
  })

  it('rolls back journal clearing together with the owned records when the data transaction fails', () => {
    const settingsPath = path.join(root, 'settings.db')
    const settings = new Database(settingsPath)
    settings.exec(`CREATE TABLE prompts (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE injection_history (key TEXT PRIMARY KEY, value TEXT);`)
    settings.close()
    assets.observe(source, observation('saved', '/saved', 'Saved body'))
    journal.receive(source, observation('pending', '/A', 'Pending body'), 8, 'Account A')
    journal.pause()
    db.exec("CREATE TRIGGER fail_clear BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'Fixture clear failure'); END")
    expect(() => journal.clearWith(filename => assets.clearData(settingsPath, filename))).toThrow('Fixture clear failure')
    journal.start()
    expect(journal.issues()).toMatchObject([{ pendingObservations: 1 }])
    expect(db.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 1 })
    journal.pause(); db.exec('DROP TRIGGER fail_clear')
    journal.clearWith(filename => assets.clearData(settingsPath, filename))
    journal.start(); journal.flush()
    expect(journal.issues()).toEqual([])
    expect(attempts).toEqual([])
  })

  it('resumes a closed pending journal only while its stored source is authorized', () => {
    journal.receive(source, observation('pending', '/A', 'Saved'), 8, 'Account A')
    journal.close(); authorized = false
    journal.resume(); journal.flush()
    expect(attempts).toEqual([])
    authorized = true
    journal.resume(); journal.flush()
    expect(attempts).toHaveLength(1)
    journal.close(); journal.resume(); journal.flush()
    expect(attempts).toHaveLength(1)
  })
})
