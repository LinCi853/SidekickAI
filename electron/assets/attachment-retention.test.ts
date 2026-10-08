import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AiAssetsStore } from '../store/ai-assets-store'
import { DEFAULT_ASSET_SETTINGS } from '../shared/asset-settings'
import { createAttachmentRetention } from './attachment-retention'
import { hasActiveBackupOperations, runBackupOperation } from '../store/backup/activity'

const day = 86400000, now = 1800000000000
let db: Database.Database, assets: AiAssetsStore, root: string, clock: number
let retention: ReturnType<typeof createAttachmentRetention> | undefined
let settings = { ...DEFAULT_ASSET_SETTINGS }, busy = false
const changed = vi.fn(), publish = vi.fn()
function add(key: string, age: number, content = key, type: 'webview' | 'freeze-snapshot' = 'webview') {
  clock = now - age
  const item = assets.beginAttachment({ id: 'source', type }, {
    conversationKey: key, title: key, name: `${key}.txt`, mimeType: 'text/plain', externalKey: key, direction: 'input',
  })
  const hash = createHash('sha256').update(content).digest('hex')
  const file = path.join(root, 'ai-assets', 'objects', hash.slice(0, 2), hash)
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
  assets.attachmentSaved(item.id, hash, Buffer.byteLength(content), false)
  return { item, file, hash }
}
function start(busyCheck = () => busy, prepare?: () => Promise<void>) {
  retention = createAttachmentRetention({ userData: root, settings: () => settings, assets: () => assets, prepare, busy: busyCheck, changed, publish, now: () => now })
  return retention
}
beforeEach(() => {
  fs.mkdirSync(path.resolve('build'), { recursive: true }); root = fs.mkdtempSync(path.resolve('build/retention-test-'))
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, source_id TEXT, source_type TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, url TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, auto_grabbed INTEGER, content_hash TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);`)
  assets = new AiAssetsStore(db); clock = now; busy = false; settings = { ...DEFAULT_ASSET_SETTINGS }
  vi.spyOn(Date, 'now').mockImplementation(() => clock); changed.mockClear(); publish.mockClear()
})
afterEach(() => {
  retention?.stop(); retention = undefined; db.close(); vi.restoreAllMocks()
  if (path.dirname(root) !== path.resolve('build') || !path.basename(root).startsWith('retention-test-')) throw new Error('Unexpected fixture root')
  fs.rmSync(root, { recursive: true, force: true })
})
describe('attachment-only retention', () => {
  it('keeps existing files until explicitly enabled', async () => {
    const old = add('old', 200 * day)
    await start().tick()
    expect(assets.getAttachment(old.item.id)).toBeDefined(); expect(fs.existsSync(old.file)).toBe(true)
    expect(retention!.status().state).toBe('disabled')
  })
  it.each([14, 30, 120] as const)('expires the exact %i-day boundary but preserves newer records and conversations', async days => {
    const expired = add('expired', days * day), recent = add('recent', days * day - 1)
    settings.fileRetentionDays = days; await start().tick()
    expect(assets.getAttachment(expired.item.id)).toBeUndefined(); expect(fs.existsSync(expired.file)).toBe(false)
    expect(assets.getAttachment(recent.item.id)).toBeDefined(); expect(db.prepare('SELECT * FROM conversations').all()).toHaveLength(2)
    expect(retention!.status()).toMatchObject({ deleted: 1, lastRun: now, state: 'idle' })
    expect(assets.attachmentExcluded('source', 'expired')).toBe(true)
  })
  it('uses successful recollection time without extending age on viewing or observing', async () => {
    const old = add('old', 40 * day)
    clock = now - day; assets.attachmentSaved(old.item.id, old.hash, 3, true)
    clock = now; assets.getAttachment(old.item.id); assets.attachments()
    expect(assets.getAttachment(old.item.id)!.updatedAt).toBe(now - day)
    settings.fileRetentionDays = 14; await start().tick()
    expect(assets.getAttachment(old.item.id)).toBeDefined()
  })
  it('preserves shared bytes, historical snapshots and message content while removing abandoned references', async () => {
    const old = add('old', 31 * day, 'shared'), recent = add('recent', day, 'shared')
    const frozen = add('frozen', 100 * day, 'snapshot', 'freeze-snapshot'), pending = add('pending', 100 * day)
    assets.attachmentPending(pending.item.id)
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run('message', old.item.conversationId, 'user', 'Preserved message', now)
    settings.fileRetentionDays = 30; await start().tick()
    expect(assets.getAttachment(old.item.id)).toBeUndefined(); expect(fs.existsSync(recent.file)).toBe(true)
    expect(assets.getAttachment(frozen.item.id)).toBeDefined(); expect(assets.getAttachment(pending.item.id)).toBeUndefined()
    expect(db.prepare('SELECT content FROM messages').get()).toEqual({ content: 'Preserved message' })
  })
  it('defers while busy and rechecks an off setting after awaiting admission', async () => {
    const old = add('old', 100 * day); settings.fileRetentionDays = 14; busy = true
    await start().tick(); expect(retention!.status().state).toBe('waiting'); expect(fs.existsSync(old.file)).toBe(true)
    busy = false; await retention!.tick(); expect(assets.getAttachment(old.item.id)).toBeUndefined()
    retention!.stop()
    const other = add('other', 100 * day)
    let release!: (value: boolean) => void
    const gate = new Promise<boolean>(resolve => { release = resolve })
    const run = start(() => busy, async () => { await gate }).tick(); settings.fileRetentionDays = 0; release(false); await run
    expect(assets.getAttachment(other.item.id)).toBeDefined()
  })
  it('does not reopen stores after shutdown during admission', async () => {
    settings.fileRetentionDays = 14
    let release!: (value: boolean) => void
    const gate = new Promise<boolean>(resolve => { release = resolve })
    const opened = vi.fn(() => assets)
    retention = createAttachmentRetention({ userData: root, settings: () => settings, assets: opened, prepare: async () => { await gate }, busy: () => busy, changed, publish })
    const run = retention.tick(); retention.stop(); release(false); await run; expect(opened).not.toHaveBeenCalled()
  })
  it('preserves files through delayed full-restore preparation that fails', async () => {
    const old = add('old', 100 * day); settings.fileRetentionDays = 14
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const restore = runBackupOperation('restore', async () => { await pending; return { success: false } })
    await start(() => hasActiveBackupOperations()).tick()
    expect(retention!.status().state).toBe('waiting'); expect(fs.existsSync(old.file)).toBe(true)
    expect(assets.getAttachment(old.item.id)).toBeDefined()
    finish(); await restore
    expect(assets.getAttachment(old.item.id)).toBeDefined()
    await retention!.tick(); expect(assets.getAttachment(old.item.id)).toBeUndefined()
  })
  it('rechecks activity synchronously when a new operation starts in the preparation microtask gap', async () => {
    const old = add('old', 100 * day); settings.fileRetentionDays = 14
    const gate = Promise.resolve()
    await start(() => busy, () => { gate.then(() => { busy = true }); return gate }).tick()
    expect(retention!.status().state).toBe('waiting')
    expect(assets.getAttachment(old.item.id)).toBeDefined(); expect(fs.existsSync(old.file)).toBe(true)
  })
  it('restores records and bytes after a database failure then succeeds on retry', async () => {
    const old = add('old', 100 * day); settings.fileRetentionDays = 14
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON asset_attachments BEGIN SELECT RAISE(ABORT, 'Deletion refused'); END")
    await start().tick(); expect(retention!.status().state).toBe('error')
    expect(assets.getAttachment(old.item.id)).toBeDefined(); expect(fs.existsSync(old.file)).toBe(true)
    db.exec('DROP TRIGGER reject_delete'); await retention!.tick()
    expect(assets.getAttachment(old.item.id)).toBeUndefined(); expect(retention!.status().error).toBeUndefined()
  })
  it('upgrades legacy attachment rows without losing their original retention age', () => {
    const old = add('legacy', 100 * day)
    db.exec('ALTER TABLE asset_attachments DROP COLUMN updated_at')
    assets = new AiAssetsStore(db)
    expect(assets.getAttachment(old.item.id)!.updatedAt).toBe(now - 100 * day)
    expect(assets.expiredAttachmentIds(now - 30 * day)).toEqual([old.item.id])
  })
})
