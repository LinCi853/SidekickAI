import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AssetCollectionIssue, AssetObservation, AssetObservationReceipt, AssetSource } from '../shared/ai-assets.types.js'

type ObservationResult = { conversationId: string; suppressed?: boolean; messageIds?: Record<string, string> }
type ObservationContext = Omit<AssetObservation, 'messages'>
interface PendingObservation {
  sequence: number; id: string; source_id: string; source_json: string; payload: string
  owner_id: number; profile_name: string; attempts: number
}
interface PendingInput {
  source_id: string; external_key: string; source_json: string; context_json: string
  message_key: string; message_id: string; attempts: number
}
interface JournalConsumer {
  authorize: (source: AssetSource) => boolean
  observe: (source: AssetSource, observation: AssetObservation) => ObservationResult
  associate: (source: AssetSource, observation: ObservationContext, externalKey: string, messageKey: string, messageId: string) => boolean
  changed: () => void
  committed: (sourceId: string) => void
}

export class AssetObservationJournal {
  private database?: Database.Database
  private timer?: ReturnType<typeof setTimeout>
  private enabled = false
  private running = false

  constructor(private filename: string, private consumer: JournalConsumer) {}

  private db(): Database.Database {
    if (this.database) return this.database
    mkdirSync(path.dirname(this.filename), { recursive: true })
    const db = new Database(this.filename)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = FULL')
      db.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, source_id TEXT NOT NULL,
          source_json TEXT NOT NULL, conversation_key TEXT NOT NULL, queue_key TEXT NOT NULL,
          payload TEXT NOT NULL, signature TEXT NOT NULL, bytes INTEGER NOT NULL,
          owner_id INTEGER NOT NULL, profile_name TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
          UNIQUE(source_id, id)
        );
        CREATE INDEX IF NOT EXISTS observation_queue ON observations(source_id, queue_key, sequence);
        CREATE TABLE IF NOT EXISTS receipts (
          source_id TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL,
          PRIMARY KEY(source_id, id)
        );
        INSERT OR IGNORE INTO receipts SELECT source_id, id, signature FROM observations;
        CREATE TABLE IF NOT EXISTS conversation_aliases (
          source_id TEXT NOT NULL, conversation_key TEXT NOT NULL, queue_key TEXT NOT NULL,
          PRIMARY KEY(source_id, conversation_key)
        );
        CREATE TABLE IF NOT EXISTS input_links (
          source_id TEXT NOT NULL, external_key TEXT NOT NULL, observation_id TEXT NOT NULL,
          source_json TEXT NOT NULL, context_json TEXT NOT NULL, message_key TEXT NOT NULL,
          message_id TEXT, status TEXT NOT NULL DEFAULT 'waiting', attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt INTEGER NOT NULL DEFAULT 0, owner_id INTEGER NOT NULL,
          profile_name TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(source_id, external_key)
        );
      `)
      this.database = db
      return db
    } catch (error) { db.close(); throw error }
  }

  receive(source: AssetSource, observation: AssetObservation, ownerId: number, profileName: string): AssetObservationReceipt {
    if (!this.consumer.authorize(source)) throw new Error('AI asset source is not authorized')
    const db = this.db()
    const id = observation.observationId ?? randomUUID()
    const payload = JSON.stringify({ ...observation, observationId: id })
    const signature = createHash('sha256').update(payload).digest('hex')
    const now = Date.now()
    db.transaction(() => {
      const existing = db.prepare('SELECT signature FROM receipts WHERE source_id = ? AND id = ?')
        .get(source.id, id) as { signature: string } | undefined
      if (existing && existing.signature !== signature) throw new Error('Observation identity was reused with different content')
      if (existing) return
      db.prepare('INSERT INTO receipts VALUES (?, ?, ?)').run(source.id, id, signature)
      const alias = db.prepare('SELECT queue_key FROM conversation_aliases WHERE source_id = ? AND conversation_key = ?')
      const prior = observation.previousConversationKey?.startsWith('document:')
        ? alias.get(source.id, observation.previousConversationKey) as { queue_key: string } | undefined : undefined
      const current = alias.get(source.id, observation.conversationKey) as { queue_key: string } | undefined
      const queueKey = prior?.queue_key ?? current?.queue_key ?? observation.previousConversationKey ?? observation.conversationKey
      if (prior && current && prior.queue_key !== current.queue_key) {
        db.prepare('UPDATE observations SET queue_key = ? WHERE source_id = ? AND queue_key = ?').run(queueKey, source.id, current.queue_key)
        db.prepare('UPDATE conversation_aliases SET queue_key = ? WHERE source_id = ? AND queue_key = ?').run(queueKey, source.id, current.queue_key)
      }
      db.prepare('INSERT OR REPLACE INTO conversation_aliases VALUES (?, ?, ?)').run(source.id, observation.conversationKey, queueKey)
      const sourceJson = JSON.stringify({ id: source.id, type: source.type })
      db.prepare(`INSERT INTO observations (id, source_id, source_json, conversation_key, queue_key, payload, signature, bytes, owner_id, profile_name, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, source.id, sourceJson, observation.conversationKey, queueKey,
        payload, signature, Buffer.byteLength(payload), ownerId, profileName, now)
      const context: ObservationContext = { conversationKey: observation.conversationKey, previousConversationKey: observation.previousConversationKey,
        title: observation.title, url: observation.url }
      const link = db.prepare(`INSERT OR IGNORE INTO input_links (source_id, external_key, observation_id, source_json, context_json,
        message_key, owner_id, profile_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const input of observation.inputAttachments ?? []) link.run(source.id, input.externalKey, id, sourceJson,
        JSON.stringify(context), input.messageKey, ownerId, profileName, now)
    })()
    this.schedule(0)
    this.consumer.changed()
    return { durable: true, observationId: id }
  }

  start(): void {
    this.enabled = true
    this.db()
    this.schedule(0)
  }

  pause(): void {
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  resume(): void {
    if (!this.database && !existsSync(this.filename)) return
    const opened = !!this.database
    const sources = this.db().prepare(`SELECT DISTINCT source_json FROM observations
      UNION SELECT DISTINCT source_json FROM input_links WHERE status != 'done'`).all() as Array<{ source_json: string }>
    if (!sources.some(row => this.consumer.authorize(JSON.parse(row.source_json) as AssetSource))) {
      if (!opened) { this.database?.close(); this.database = undefined }
      return
    }
    this.enabled = true
    this.schedule(0)
  }

  close(): void {
    this.pause()
    this.database?.close()
    this.database = undefined
  }

  clear(): void {
    if (this.enabled || this.running) throw new Error('Asset collection must be stopped before clearing its journal')
    const db = this.db()
    db.transaction(() => {
      db.prepare('DELETE FROM input_links').run()
      db.prepare('DELETE FROM observations').run()
      db.prepare('DELETE FROM receipts').run()
      db.prepare('DELETE FROM conversation_aliases').run()
    })()
    this.consumer.changed()
  }

  clearWith(clearDatabase: (filename: string) => void): void {
    if (this.enabled || this.running) throw new Error('Asset collection must be stopped before clearing its journal')
    this.db()
    this.close()
    clearDatabase(this.filename)
    this.consumer.changed()
  }

  private schedule(delay: number): void {
    if (!this.enabled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, delay)
    this.timer.unref?.()
  }

  private retry(table: 'observations' | 'input_links', identity: unknown[], attempts: number): void {
    const condition = table === 'observations' ? 'sequence = ?' : 'source_id = ? AND external_key = ?'
    this.db().prepare(`UPDATE ${table} SET attempts = attempts + 1, next_attempt = ?, updated_at = ? WHERE ${condition}`)
      .run(Date.now() + 1000 * 2 ** Math.min(attempts, 3), Date.now(), ...identity)
  }

  flush(): void {
    if (!this.enabled || this.running) return
    this.running = true
    try {
      const db = this.db()
      for (let index = 0; index < 8; index += 1) {
        const row = db.prepare(`SELECT * FROM observations o WHERE next_attempt <= ? AND NOT EXISTS
          (SELECT 1 FROM observations prior WHERE prior.source_id = o.source_id AND prior.queue_key = o.queue_key AND prior.sequence < o.sequence)
          ORDER BY sequence LIMIT 1`).get(Date.now()) as PendingObservation | undefined
        if (!row) break
        try {
          const source = JSON.parse(row.source_json) as AssetSource
          if (!this.consumer.authorize(source)) throw new Error('Stored AI asset source is not currently authorized')
          const observation = JSON.parse(row.payload) as AssetObservation
          const result = this.consumer.observe(source, observation)
          db.transaction(() => {
            const links = db.prepare('SELECT external_key, message_key FROM input_links WHERE source_id = ? AND observation_id = ? AND status = ?')
              .all(row.source_id, row.id, 'waiting') as Array<{ external_key: string; message_key: string }>
            for (const link of links) {
              const messageId = result.suppressed ? undefined : result.messageIds?.[link.message_key]
              db.prepare('UPDATE input_links SET message_id = ?, status = ?, next_attempt = 0, updated_at = ? WHERE source_id = ? AND external_key = ?')
                .run(messageId ?? null, messageId ? 'ready' : 'done', Date.now(), row.source_id, link.external_key)
            }
            db.prepare('DELETE FROM observations WHERE sequence = ?').run(row.sequence)
          })()
          this.consumer.committed(source.id)
        } catch { this.retry('observations', [row.sequence], row.attempts) }
      }
      for (let index = 0; index < 8; index += 1) {
        const row = db.prepare('SELECT * FROM input_links WHERE status = ? AND next_attempt <= ? ORDER BY rowid LIMIT 1')
          .get('ready', Date.now()) as PendingInput | undefined
        if (!row) break
        try {
          const source = JSON.parse(row.source_json) as AssetSource
          if (!this.consumer.authorize(source)) throw new Error('Stored AI asset source is not currently authorized')
          const linked = this.consumer.associate(source, JSON.parse(row.context_json) as ObservationContext,
            row.external_key, row.message_key, row.message_id)
          if (!linked) { this.retry('input_links', [row.source_id, row.external_key], row.attempts); continue }
          db.prepare('UPDATE input_links SET status = ?, updated_at = ? WHERE source_id = ? AND external_key = ?')
            .run('done', Date.now(), row.source_id, row.external_key)
          this.consumer.committed(source.id)
        } catch { this.retry('input_links', [row.source_id, row.external_key], row.attempts) }
      }
      this.consumer.changed()
      const next = db.prepare(`SELECT MIN(next_attempt) AS due FROM (
        SELECT next_attempt FROM observations o WHERE NOT EXISTS (SELECT 1 FROM observations prior
          WHERE prior.source_id = o.source_id AND prior.queue_key = o.queue_key AND prior.sequence < o.sequence)
        UNION ALL SELECT next_attempt FROM input_links WHERE status = 'ready')`).get() as { due: number | null }
      if (next.due !== null) this.schedule(Math.max(0, next.due - Date.now()))
    } catch (error) {
      console.warn('[ai-assets] Durable observation replay is waiting:', error)
      this.schedule(8000)
    } finally { this.running = false }
  }

  issues(): AssetCollectionIssue[] {
    if (!this.database) return []
    const rows = this.database.prepare(`SELECT source_id, profile_name, MAX(owner_id) AS owner_id, SUM(attempts) AS failures,
      MAX(updated_at) AS updated_at, SUM(pending) AS pending, SUM(bytes) AS bytes FROM (
      SELECT source_id, profile_name, owner_id, attempts, updated_at, 1 AS pending, bytes FROM observations
      UNION ALL SELECT source_id, profile_name, owner_id, attempts, updated_at, 0 AS pending, 0 AS bytes FROM input_links WHERE status != 'done')
      GROUP BY source_id`).all() as Array<{ source_id: string; profile_name: string; owner_id: number; failures: number; updated_at: number; pending: number; bytes: number }>
    return rows.map(row => ({ webContentsId: 0, profileId: row.source_id, profileName: row.profile_name,
      failures: row.failures, updatedAt: row.updated_at, pendingObservations: row.pending, pendingBytes: row.bytes }))
  }
}

let activeJournal: AssetObservationJournal | undefined
export function setAssetCollectionJournal(journal: AssetObservationJournal): void {
  activeJournal?.close()
  activeJournal = journal
}
export function closeAssetCollectionJournal(): void { activeJournal?.close() }
export function resumeAssetCollectionJournal(): void { activeJournal?.resume() }
