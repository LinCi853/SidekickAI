import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AiAssetsStore } from '../store/ai-assets-store'
import { assertAssetClearAllowed, clearAssetDirectories } from './clear-data'

let directory: string
let db: Database.Database
let settings: Database.Database
let assets: AiAssetsStore
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-clear-'))
  db = new Database(path.join(directory, 'chat.db'))
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, url TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, auto_grabbed INTEGER, content_hash TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
    CREATE TABLE login_traces (value TEXT); INSERT INTO login_traces VALUES ('keep');`)
  assets = new AiAssetsStore(db)
  assets.observe({ id: 'account', type: 'webview' }, { conversationKey: 'one', title: 'One', messages: [{ key: 'a', role: 'assistant', content: 'old', reasoning: 'thought' }] })
  assets.observe({ id: 'account', type: 'webview' }, { conversationKey: 'one', title: 'One', messages: [{ key: 'a', role: 'assistant', content: 'revised' }] })
  assets.beginAttachment({ id: 'account', type: 'webview' }, { conversationKey: 'one', title: 'One', name: 'image', mimeType: 'image/png', externalKey: 'file', direction: 'input' })
  db.exec("INSERT INTO conversations VALUES ('api', 'provider', 'api', 'API', 1, 1, NULL)")
  settings = new Database(path.join(directory, 'settings.db'))
  settings.exec(`CREATE TABLE prompts (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE injection_history (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE providers (value TEXT); INSERT INTO providers VALUES ('keep');`)
  settings.prepare('INSERT INTO prompts VALUES (?, ?)').run('__data__', JSON.stringify({ version: 1, prompts: [{ id: 'manual', content: 'template' }] }))
  settings.prepare('INSERT INTO injection_history VALUES (?, ?)').run('__data__', JSON.stringify({ version: 1, records: [{ composedText: 'text' }] }))
  for (const name of ['ai-assets', '.ai-assets-pending', 'notes']) {
    fs.mkdirSync(path.join(directory, name))
    fs.writeFileSync(path.join(directory, name, 'fixture'), 'original bytes')
  }
})
afterEach(() => { db.close(); settings.close(); fs.rmSync(directory, { recursive: true, force: true }) })

describe('AI asset clearing', () => {
  it('removes every owned record and original while retaining configuration, notes and logs', () => {
    clearAssetDirectories(directory, () => assets.clearData(settings.name))
    for (const table of ['conversations', 'messages', 'asset_conversation_keys', 'asset_message_state', 'asset_observations', 'asset_revisions', 'asset_text_events', 'asset_attachments'])
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toHaveLength(0)
    expect(assets.usage().totalCharacters).toBe(0)
    expect(JSON.parse((settings.prepare('SELECT value FROM prompts').get() as { value: string }).value)).toEqual({ version: 1, prompts: [] })
    expect(JSON.parse((settings.prepare('SELECT value FROM injection_history').get() as { value: string }).value)).toEqual({ version: 1, records: [] })
    expect(db.prepare('SELECT * FROM login_traces').all()).toHaveLength(1)
    expect(settings.prepare('SELECT * FROM providers').all()).toHaveLength(1)
    expect(fs.readFileSync(path.join(directory, 'notes', 'fixture'), 'utf8')).toBe('original bytes')
    expect(fs.existsSync(path.join(directory, 'ai-assets'))).toBe(false)
    expect(fs.existsSync(path.join(directory, '.ai-assets-pending'))).toBe(false)
    expect(fs.existsSync(path.join(directory, '.ai-assets-clearing'))).toBe(false)
  })
  it('rolls back both databases and restores original bytes when a template deletion fails', () => {
    settings.exec("CREATE TRIGGER reject_clear BEFORE UPDATE ON injection_history BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    expect(() => clearAssetDirectories(directory, () => assets.clearData(settings.name))).toThrow('blocked')
    expect(db.prepare('SELECT * FROM conversations').all()).toHaveLength(2)
    expect(assets.usage().totalCharacters).toBeGreaterThan(0)
    expect(JSON.parse((settings.prepare('SELECT value FROM prompts').get() as { value: string }).value).prompts).toHaveLength(1)
    for (const name of ['ai-assets', '.ai-assets-pending']) expect(fs.readFileSync(path.join(directory, name, 'fixture'), 'utf8')).toBe('original bytes')
    settings.exec('DROP TRIGGER reject_clear')
    clearAssetDirectories(directory, () => assets.clearData(settings.name))
    expect(db.prepare('SELECT * FROM conversations').all()).toHaveLength(0)
  })
  it('refuses enabled collection or unfinished responses and transfers', () => {
    expect(() => assertAssetClearAllowed(true, false)).toThrow('AI资产')
    expect(() => assertAssetClearAllowed(false, true)).toThrow('API')
    expect(() => assertAssetClearAllowed(false, false)).not.toThrow()
  })
  it('can retry cleanup of a committed original directory without restoring erased content', () => {
    const staging = path.join(directory, '.ai-assets-clearing')
    fs.mkdirSync(staging)
    fs.writeFileSync(path.join(staging, 'state.json'), JSON.stringify({ committed: true }))
    fs.renameSync(path.join(directory, 'ai-assets'), path.join(staging, 'ai-assets'))
    clearAssetDirectories(directory, () => assets.clearData(settings.name))
    expect(fs.existsSync(staging)).toBe(false)
    expect(fs.existsSync(path.join(directory, 'ai-assets'))).toBe(false)
  })
})
