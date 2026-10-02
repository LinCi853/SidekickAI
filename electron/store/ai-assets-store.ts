import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ChatMessage } from '../shared/chat.types.js'
import type {
  AssetAttachment, AssetAttachmentInput, AssetMessageDetail, AssetMessageStatus,
  AssetObservation, AssetObservedMessage, AssetPromptSuggestion, AssetRevision,
  AssetSource, AssetTextUsage,
} from '../shared/ai-assets.types.js'
import { canonicalWebConversationUrl } from '../assets/conversation-identity.js'
import { AssetGraphStore } from './asset-graph-store.js'
import { classifyCapturedNoise } from '../assets/noise.js'
import { addedCharacters, countCharacters, promptWeight } from '../assets/text-usage.js'

interface MessageState {
  message_id: string
  external_key: string
  reasoning: string
  status: AssetMessageStatus
  input_characters: number
  reasoning_characters: number
  output_characters: number
}
interface AttachmentRow {
  id: string; conversation_id: string; message_id: string | null; source_id: string
  name: string; mime_type: string; source_url: string | null; direction: 'input' | 'output'
  status: AssetAttachment['status']; sha256: string | null; size: number | null
  error: string | null; created_at: number
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const attachment = (row: AttachmentRow): AssetAttachment => ({
  id: row.id, conversationId: row.conversation_id, messageId: row.message_id ?? undefined,
  sourceId: row.source_id, name: row.name, mimeType: row.mime_type,
  sourceUrl: row.source_url ?? undefined, direction: row.direction, status: row.status,
  sha256: row.sha256 ?? undefined, size: row.size ?? undefined, error: row.error ?? undefined,
  createdAt: row.created_at,
})

export class AiAssetsStore {
  readonly graph: AssetGraphStore
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_conversation_keys (
        source_id TEXT NOT NULL, external_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
        PRIMARY KEY(source_id, external_key),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_message_state (
        message_id TEXT PRIMARY KEY, external_key TEXT NOT NULL, reasoning TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'complete', input_characters INTEGER NOT NULL DEFAULT 0,
        reasoning_characters INTEGER NOT NULL DEFAULT 0, output_characters INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_observations (
        message_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(message_id, signature),
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS asset_message_external ON asset_message_state(external_key);
      CREATE TABLE IF NOT EXISTS asset_revisions (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, content TEXT NOT NULL,
        reasoning TEXT NOT NULL, status TEXT NOT NULL, captured_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS asset_revision_message ON asset_revisions(message_id, captured_at);
      CREATE TABLE IF NOT EXISTS asset_message_formats (
        message_id TEXT PRIMARY KEY, markdown TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_cleanup_events (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, source_id TEXT NOT NULL, source_type TEXT NOT NULL,
        adapter TEXT NOT NULL, reason TEXT NOT NULL, messages INTEGER NOT NULL, conversations INTEGER NOT NULL,
        signature TEXT NOT NULL DEFAULT '', api_origin TEXT,
        UNIQUE(source_id, adapter, reason, signature)
      );
      CREATE TABLE IF NOT EXISTS asset_local_titles (
        conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_text_events (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, input_characters INTEGER NOT NULL,
        reasoning_characters INTEGER NOT NULL, output_characters INTEGER NOT NULL, captured_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS asset_event_time ON asset_text_events(captured_at);
      CREATE TABLE IF NOT EXISTS asset_attachments (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT, source_id TEXT NOT NULL,
        external_key TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL, source_url TEXT,
        direction TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sha256 TEXT, size INTEGER,
        error TEXT, created_at INTEGER NOT NULL, UNIQUE(conversation_id, external_key),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL
      );
    `)
    this.graph = new AssetGraphStore(db)
    const seed = db.prepare('INSERT OR IGNORE INTO asset_observations VALUES (?, ?)')
    const versions = db.prepare(`SELECT m.id, m.content, s.reasoning FROM messages m JOIN asset_message_state s ON s.message_id = m.id
      UNION ALL SELECT message_id AS id, content, reasoning FROM asset_revisions`).all() as Array<{ id: string; content: string; reasoning: string }>
    db.transaction(() => { for (const item of versions) seed.run(item.id, digest(JSON.stringify([item.content, item.reasoning]))) })()
  }

  clearData(settingsPath: string): void {
    this.db.prepare('ATTACH DATABASE ? AS asset_settings').run(settingsPath)
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM conversations').run()
        this.db.prepare('DELETE FROM asset_exclusions').run()
        this.db.prepare('DELETE FROM asset_cleanup_events').run()
        this.db.prepare("UPDATE asset_settings.prompts SET value = json_set(value, '$.prompts', json('[]')) WHERE key = '__data__'").run()
        this.db.prepare("UPDATE asset_settings.injection_history SET value = json_set(value, '$.records', json('[]')) WHERE key = '__data__'").run()
      })()
    } finally { this.db.exec('DETACH DATABASE asset_settings') }
  }

  conversation(source: AssetSource, observation: Omit<AssetObservation, 'messages'>): string {
    if (this.graph.excluded(source.id, observation.conversationKey)) throw new Error('这段对话已从本地记录中排除')
    const known = this.db.prepare('SELECT conversation_id FROM asset_conversation_keys WHERE source_id = ? AND external_key = ?')
      .get(source.id, observation.conversationKey) as { conversation_id: string } | undefined
    if (known) return known.conversation_id
    const canonical = source.type === 'webview' && observation.url ? canonicalWebConversationUrl(observation.url) : undefined
    const legacy = canonical === observation.conversationKey
      ? (this.db.prepare('SELECT id, url FROM conversations WHERE source_id = ? AND source_type = ? ORDER BY updated_at DESC')
        .all(source.id, source.type) as Array<{ id: string; url: string | null }>).find(item => item.url && canonicalWebConversationUrl(item.url) === canonical)
      : observation.url ? this.db.prepare(`SELECT id FROM conversations
        WHERE source_id = ? AND source_type = ? AND url = ? AND NOT EXISTS
        (SELECT 1 FROM asset_conversation_keys WHERE conversation_id = conversations.id)
        ORDER BY updated_at DESC LIMIT 1`).get(source.id, source.type, observation.url) as { id: string } | undefined : undefined
    const id = legacy?.id ?? randomUUID()
    const now = Date.now()
    if (!legacy) this.db.prepare('INSERT INTO conversations (id, source_id, source_type, title, created_at, updated_at, url) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, source.id, source.type, observation.title || '新对话', now, now, observation.url ?? null)
    this.db.prepare('INSERT INTO asset_conversation_keys VALUES (?, ?, ?)').run(source.id, observation.conversationKey, id)
    return id
  }

  observe(source: AssetSource, observation: AssetObservation): { conversationId: string; suppressed?: boolean } {
    if (this.graph.excluded(source.id, observation.conversationKey)) return { conversationId: '', suppressed: true }
    return this.db.transaction(() => {
      for (const rejected of observation.rejected ?? []) this.recordCleanup(source, observation.adapter ?? 'dom', rejected.reason, 1, 0, digest(JSON.stringify([observation.visitId, rejected.key, rejected.signature])))
      const valid = observation.messages.filter(message => {
        if (source.type !== 'webview') return true
        const reason = !message.content && !message.reasoning && !message.status ? 'empty-capture' : undefined
        if (!reason) return true
        this.recordCleanup(source, observation.adapter ?? 'dom', reason, 1, 0, digest(message.content))
        return false
      })
      if (!valid.length) return { conversationId: '' }
      observation = { ...observation, messages: valid }

      if (observation.previousConversationKey?.startsWith('document:') && !observation.conversationKey.startsWith('document:')) {
        const draft = this.db.prepare('SELECT conversation_id FROM asset_conversation_keys WHERE source_id = ? AND external_key = ?')
          .get(source.id, observation.previousConversationKey) as { conversation_id: string } | undefined
        const matches = draft && observation.messages.some(message => this.db.prepare(`SELECT 1 FROM messages m
          LEFT JOIN asset_nodes n ON n.message_id = m.id LEFT JOIN asset_message_state s ON s.message_id = m.id
          WHERE m.conversation_id = ? AND (n.source_key = ? OR s.external_key = ?) AND m.content = ?`)
          .get(draft.conversation_id, message.key, message.key, message.content))
        if (matches) this.db.prepare('INSERT OR IGNORE INTO asset_conversation_keys VALUES (?, ?, ?)')
          .run(source.id, observation.conversationKey, draft.conversation_id)
      }
      const conversationId = this.conversation(source, observation)
      if (observation.snapshot) this.graph.observe(conversationId, source.id, observation,
        (message, messageId) => this.captureMessage(conversationId, message, messageId))
      else for (const message of observation.messages) this.capture(conversationId, message)
      if (observation.visitId) this.graph.viewEvent(conversationId, `web:${observation.visitId}`)
      const title = this.localTitle(conversationId) ?? observation.title ?? '新对话'
      this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title != ?').run(title, Date.now(), conversationId, title)
      return { conversationId }
    })()
  }

  capture(conversationId: string, observed: AssetObservedMessage, messageId?: string): string {
    return this.db.transaction(() => this.captureMessage(conversationId, observed, messageId))()
  }

  private captureMessage(conversationId: string, observed: AssetObservedMessage, messageId?: string): string {
    const current = messageId
      ? this.db.prepare('SELECT m.*, s.* FROM messages m LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.id = ?').get(messageId)
      : this.db.prepare(`SELECT m.*, s.* FROM messages m JOIN asset_message_state s ON s.message_id = m.id
          WHERE m.conversation_id = ? AND s.external_key = ?`).get(conversationId, observed.key)
    const previous = current as (MessageState & { id: string; content: string }) | undefined
    const id = previous?.id ?? messageId ?? randomUUID()
    const now = Date.now()
    if (!previous) this.db.prepare(`INSERT INTO messages (id, conversation_id, role, content, created_at, auto_grabbed)
      VALUES (?, ?, ?, ?, ?, (SELECT source_type = 'webview' FROM conversations WHERE id = ?))`)
      .run(id, conversationId, observed.role, '', now, conversationId)
    this.db.prepare('INSERT OR IGNORE INTO asset_message_state (message_id, external_key) VALUES (?, ?)').run(id, observed.key)
    const status = observed.status ?? 'complete'
    const previousText = previous?.message_id ? previous.content : ''
    const previousReasoning = previous?.reasoning ?? ''
    const text = ['withdrawn', 'retained'].includes(status) && !observed.content ? previousText : observed.content
    const reasoning = observed.reasoning ?? previousReasoning
    if (observed.markdownContent !== undefined) this.db.prepare(`INSERT INTO asset_message_formats VALUES (?, ?)
      ON CONFLICT(message_id) DO UPDATE SET markdown = excluded.markdown`).run(id, observed.markdownContent)
    const signature = digest(JSON.stringify([text, reasoning]))
    const fresh = this.db.prepare('INSERT OR IGNORE INTO asset_observations VALUES (?, ?)').run(id, signature).changes > 0
    const input = fresh && observed.role !== 'assistant' ? addedCharacters(previousText, text) : 0
    const output = fresh && observed.role === 'assistant' ? addedCharacters(previousText, text) : 0
    const thought = fresh ? addedCharacters(previousReasoning, reasoning) : 0
    const changed = text !== previousText || reasoning !== previousReasoning || status !== previous?.status
    if (!fresh && !changed) return id
    const revision = previous && changed && (
      !text.startsWith(previousText) || !reasoning.startsWith(previousReasoning)
      || status === 'withdrawn' || status === 'retained'
    )
    if (revision) this.db.prepare('INSERT INTO asset_revisions VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, previousText, previousReasoning, previous.status ?? 'complete', now)
    this.db.prepare('UPDATE messages SET content = ?, content_hash = NULL WHERE id = ?').run(text, id)
    this.db.prepare(`UPDATE asset_message_state SET reasoning = ?, status = ?,
      input_characters = input_characters + ?, reasoning_characters = reasoning_characters + ?,
      output_characters = output_characters + ? WHERE message_id = ?`).run(reasoning, status, input, thought, output, id)
    if (input + output + thought) this.db.prepare('INSERT INTO asset_text_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, input, thought, output, now)
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId)
    return id
  }

  captureApi(message: ChatMessage, status: AssetMessageStatus = 'complete', reasoning?: string): void {
    this.capture(message.conversationId, { key: message.id, role: message.role, content: message.content, reasoning, status }, message.id)
  }
  recoverInterruptedStreams(): void {
    this.db.prepare("UPDATE asset_message_state SET status = 'failed' WHERE status = 'streaming'").run()
  }

  editMessage(id: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>): void {
    const message = this.db.prepare('SELECT m.*, s.external_key, s.reasoning FROM messages m LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.id = ?')
      .get(id) as { conversation_id: string; content: string; role: ChatMessage['role']; external_key?: string; reasoning?: string } | undefined
    if (!message || updates.content === undefined) return
    const content = updates.content
    if (updates.role && updates.role !== message.role) throw new Error('本地修订不能更改消息角色')
    this.db.transaction(() => {
      if (!message.external_key) this.captureMessage(message.conversation_id, { key: id, role: message.role, content: message.content }, id)
      const local = this.db.prepare('SELECT content FROM asset_local_edits WHERE message_id = ?').get(id) as { content: string } | undefined
      const previous = local?.content ?? message.content
      const signature = digest(JSON.stringify([content, message.reasoning ?? '']))
      const fresh = this.db.prepare('INSERT OR IGNORE INTO asset_observations VALUES (?, ?)').run(id, signature).changes > 0
      if (previous !== content) this.db.prepare('INSERT INTO asset_revisions VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), id, previous, message.reasoning ?? '', 'complete', Date.now())
      const count = fresh ? addedCharacters(previous, content) : 0
      const input = message.role === 'assistant' ? 0 : count
      const output = message.role === 'assistant' ? count : 0
      this.db.prepare('UPDATE asset_message_state SET input_characters = input_characters + ?, output_characters = output_characters + ? WHERE message_id = ?').run(input, output, id)
      if (count) this.db.prepare('INSERT INTO asset_text_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, input, 0, output, Date.now())
      this.db.prepare('INSERT INTO asset_local_edits VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET content = excluded.content').run(id, content)
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), message.conversation_id)
    })()
  }
  displayMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      const edit = this.db.prepare('SELECT content FROM asset_local_edits WHERE message_id = ?').get(message.id) as { content: string } | undefined
      return edit ? { ...message, content: edit.content } : message
    })
  }
  localTitle(id: string): string | undefined {
    return (this.db.prepare('SELECT title FROM asset_local_titles WHERE conversation_id = ?').get(id) as { title: string } | undefined)?.title
  }
  renameConversation(id: string, title: string): void {
    const value = title.trim()
    if (!value || value.length > 500) throw new Error('请输入有效的对话名称')
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO asset_local_titles VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title').run(id, value)
      this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(value, Date.now(), id)
    })()
  }
  deleteConversation(id: string): void {
    this.db.transaction(() => { this.graph.excludeConversation(id); this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id) })()
  }
  deleteMessage(id: string): void {
    this.db.transaction(() => { this.graph.excludeMessage(id); this.db.prepare('DELETE FROM messages WHERE id = ?').run(id) })()
  }
  recordCleanup(source: AssetSource, adapter: string, reason: string, messages: number, conversations: number, signature: string, apiOrigin?: string): void {
    this.db.prepare('INSERT OR IGNORE INTO asset_cleanup_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), Date.now(), source.id, source.type, adapter, reason, messages, conversations, signature, apiOrigin ?? null)
  }
  cleanupRecords(): import('../shared/ai-assets.types.js').AssetCleanupRecord[] {
    return this.db.prepare(`SELECT id, created_at AS createdAt, source_id AS sourceId, source_type AS sourceType,
      adapter, reason, messages, conversations, api_origin AS apiOrigin FROM asset_cleanup_events ORDER BY created_at DESC LIMIT 500`).all() as import('../shared/ai-assets.types.js').AssetCleanupRecord[]
  }
  cleanupNoise(): { deletedCount: number; messages: number } {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT m.id, m.conversation_id, m.content, c.source_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.source_type = 'webview' AND m.auto_grabbed = 1 AND NOT EXISTS (SELECT 1 FROM asset_local_edits e WHERE e.message_id = m.id)`).all() as Array<{ id: string; conversation_id: string; content: string; source_id: string }>
      const affected = new Set<string>(); let messages = 0; let deletedCount = 0
      for (const row of rows) {
        const reason = classifyCapturedNoise(row.content)
        if (!reason || reason === 'empty-capture') continue
        this.graph.excludeMessage(row.id)
        this.db.prepare('DELETE FROM messages WHERE id = ?').run(row.id)
        this.recordCleanup({ id: row.source_id, type: 'webview' }, 'legacy-dom', reason, 1, 0, digest(row.content))
        affected.add(row.conversation_id); messages++
      }
      const empty = this.db.prepare(`SELECT c.id, c.source_id FROM conversations c WHERE c.source_type = 'webview'
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM asset_attachments a WHERE a.conversation_id = c.id)`).all() as Array<{ id: string; source_id: string }>
      for (const row of empty) {
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(row.id)
        this.recordCleanup({ id: row.source_id, type: 'webview' }, 'legacy-dom', affected.has(row.id) ? 'invalid-conversation' : 'empty-conversation', 0, 1, row.id)
        deletedCount++
      }
      return { deletedCount, messages }
    })()
  }

  details(conversationId: string): AssetMessageDetail[] {
    const rows = this.db.prepare(`SELECT m.id, m.content, m.role, s.* FROM messages m
      LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid`)
      .all(conversationId) as Array<MessageState & { id: string; content: string; role: string }>
    return rows.map(row => ({
      markdownContent: (this.db.prepare('SELECT markdown FROM asset_message_formats WHERE message_id = ?').get(row.id) as { markdown: string } | undefined)?.markdown,
      observations: (this.db.prepare('SELECT signature FROM asset_observations WHERE message_id = ?').all(row.id) as Array<{ signature: string }>).map(item => item.signature),
      locallyEdited: !!this.db.prepare('SELECT 1 FROM asset_local_edits WHERE message_id = ?').get(row.id),
      messageId: row.id, reasoning: row.reasoning ?? '', status: row.status ?? 'complete',
      inputCharacters: row.input_characters ?? (row.role !== 'assistant' ? countCharacters(row.content) : 0),
      reasoningCharacters: row.reasoning_characters ?? 0,
      outputCharacters: row.output_characters ?? (row.role === 'assistant' ? countCharacters(row.content) : 0),
      revisions: (this.db.prepare('SELECT * FROM asset_revisions WHERE message_id = ? ORDER BY captured_at, rowid').all(row.id) as Array<{
        id: string; message_id: string; content: string; reasoning: string; status: AssetMessageStatus; captured_at: number
      }>).map(r => ({ id: r.id, messageId: r.message_id, content: r.content, reasoning: r.reasoning, status: r.status, capturedAt: r.captured_at } satisfies AssetRevision)),
    }))
  }

  usage(sourceId?: string, conversationId?: string): AssetTextUsage {
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_characters), 0) AS input,
      COALESCE(SUM(reasoning_characters), 0) AS reasoning, COALESCE(SUM(output_characters), 0) AS output
      FROM asset_message_state s JOIN messages m ON m.id = s.message_id
      JOIN conversations c ON c.id = m.conversation_id WHERE (? IS NULL OR c.source_id = ?) AND (? IS NULL OR c.id = ?)`)
      .get(sourceId ?? null, sourceId ?? null, conversationId ?? null, conversationId ?? null) as { input: number; reasoning: number; output: number }
    const legacy = this.db.prepare(`SELECT role, content FROM messages
      WHERE NOT EXISTS (SELECT 1 FROM asset_message_state WHERE message_id = messages.id)
      AND conversation_id IN (SELECT id FROM conversations WHERE source_type != 'freeze-snapshot')
      AND (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE source_id = ?)) AND (? IS NULL OR conversation_id = ?)`)
      .all(sourceId ?? null, sourceId ?? null, conversationId ?? null, conversationId ?? null) as Array<{ role: string; content: string }>
    for (const message of legacy) row[message.role === 'assistant' ? 'output' : 'input'] += countCharacters(message.content)
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const today = this.db.prepare(`SELECT COALESCE(SUM(input_characters + reasoning_characters + output_characters), 0) AS count
      FROM asset_text_events e JOIN messages m ON m.id = e.message_id
      JOIN conversations c ON c.id = m.conversation_id WHERE captured_at >= ? AND (? IS NULL OR c.source_id = ?) AND (? IS NULL OR c.id = ?)`)
      .get(start.getTime(), sourceId ?? null, sourceId ?? null, conversationId ?? null, conversationId ?? null) as { count: number }
    return { inputCharacters: row.input, reasoningCharacters: row.reasoning, outputCharacters: row.output,
      totalCharacters: row.input + row.reasoning + row.output, todayCharacters: today.count }
  }

  beginAttachment(source: AssetSource, input: AssetAttachmentInput, knownConversationId?: string): AssetAttachment {
    const conversationId = knownConversationId ?? this.conversation(source, input)
    const known = this.db.prepare('SELECT * FROM asset_attachments WHERE conversation_id = ? AND external_key = ?')
      .get(conversationId, input.externalKey) as AttachmentRow | undefined
    if (known) return attachment(known)
    const message = input.messageKey ? this.sourceMessage(conversationId, input.messageKey) : undefined
    const id = randomUUID()
    this.db.prepare(`INSERT INTO asset_attachments (id, conversation_id, message_id, source_id, external_key,
      name, mime_type, source_url, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, conversationId, message?.id ?? null, source.id, input.externalKey, input.name,
        input.mimeType || 'application/octet-stream', input.sourceUrl ?? null, input.direction, Date.now())
    return this.getAttachment(id)!
  }

  getAttachment(id: string): AssetAttachment | undefined {
    const row = this.db.prepare('SELECT * FROM asset_attachments WHERE id = ?').get(id) as AttachmentRow | undefined
    return row && attachment(row)
  }
  attachments(conversationId?: string): AssetAttachment[] {
    const rows = conversationId
      ? this.db.prepare('SELECT * FROM asset_attachments WHERE conversation_id = ? ORDER BY created_at DESC').all(conversationId)
      : this.db.prepare('SELECT * FROM asset_attachments ORDER BY created_at DESC').all()
    return (rows as AttachmentRow[]).map(attachment)
  }
  attachmentSaved(id: string, sha256: string, size: number, reused: boolean): void {
    this.db.prepare('UPDATE asset_attachments SET status = ?, sha256 = ?, size = ?, error = NULL WHERE id = ?')
      .run(reused ? 'reused' : 'saved', sha256, size, id)
  }
  attachmentFailed(id: string, error: string): void {
    this.db.prepare("UPDATE asset_attachments SET status = 'failed', error = ? WHERE id = ?").run(error, id)
  }
  attachmentPending(id: string): void {
    this.db.prepare("UPDATE asset_attachments SET status = 'pending', error = NULL WHERE id = ?").run(id)
  }
  importDetails(conversationId: string, sourceId: string, messages: Array<{ id?: string; asset?: AssetMessageDetail }>, files: AssetAttachment[], graph?: import('../shared/ai-assets.types.js').AssetGraphExport): void {
    const current = this.details(conversationId)
    const mapped = new Map<string, string>()
    messages.forEach((message, index) => {
      const id = current[index]?.messageId
      if (!id) return
      if (message.id) mapped.set(message.id, id)
      const value = message.asset
      if (!value) return
      const count = (n: number) => Number.isSafeInteger(n) && n >= 0 ? n : 0
      this.db.prepare(`INSERT INTO asset_message_state VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, id, typeof value.reasoning === 'string' ? value.reasoning : '',
          ['streaming', 'complete', 'withdrawn', 'retained', 'stopped', 'failed'].includes(value.status) ? value.status : 'complete',
          count(value.inputCharacters), count(value.reasoningCharacters), count(value.outputCharacters))
      if (value.observations !== undefined && (!Array.isArray(value.observations) || value.observations.length > 100000)) throw new Error('Invalid known text versions')
      const signatureStatement = this.db.prepare('INSERT OR IGNORE INTO asset_observations VALUES (?, ?)')
      for (const signature of value.observations ?? []) {
        if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid text version signature')
        signatureStatement.run(id, signature)
      }
      if (typeof value.markdownContent === 'string') this.db.prepare('INSERT INTO asset_message_formats VALUES (?, ?)').run(id, value.markdownContent)
      for (const revision of value.revisions ?? []) {
        if (typeof revision.content !== 'string' || typeof revision.reasoning !== 'string') throw new Error('Invalid asset revision')
        this.db.prepare('INSERT INTO asset_revisions VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), id, revision.content, revision.reasoning, revision.status, count(revision.capturedAt))
      }
    })
    if (graph) this.graph.import(conversationId, sourceId, graph, mapped)
    for (const item of files) {
      if (typeof item.name !== 'string' || !['input', 'output'].includes(item.direction)) throw new Error('Invalid asset attachment')
      this.db.prepare(`INSERT INTO asset_attachments (id, conversation_id, message_id, source_id, external_key,
        name, mime_type, source_url, direction, status, sha256, size, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), conversationId, item.messageId ? mapped.get(item.messageId) ?? null : null,
          item.sourceId || sourceId, randomUUID(), item.name, item.mimeType || 'application/octet-stream', item.sourceUrl ?? null,
          item.direction, 'pending', /^[a-f0-9]{64}$/.test(item.sha256 ?? '') ? item.sha256 : null,
          Number.isSafeInteger(item.size) && item.size! >= 0 ? item.size : null,
          '导入的是资料引用；原件需通过完整备份恢复或重新获取', Number.isSafeInteger(item.createdAt) ? item.createdAt : Date.now())
    }
  }
  associateAttachments(sourceId: string, observation: Omit<AssetObservation, 'messages'>, messageKey: string, ids: string[]): void {
    const conversationId = this.conversation({ id: sourceId, type: 'webview' }, observation)
    const message = this.sourceMessage(conversationId, messageKey)
    if (!message) throw new Error('Attachment message not found')
    this.db.transaction(() => {
      for (const id of ids) this.db.prepare('UPDATE asset_attachments SET conversation_id = ?, message_id = ? WHERE id = ? AND source_id = ?')
        .run(conversationId, message.id, id, sourceId)
    })()
  }
  private sourceMessage(conversationId: string, key: string): { id: string } | undefined {
    const candidates = this.db.prepare(`SELECT m.id FROM messages m LEFT JOIN asset_nodes n ON n.message_id = m.id
      LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.conversation_id = ? AND (n.source_key = ? OR s.external_key = ?)
      ORDER BY m.created_at DESC, m.rowid DESC`).all(conversationId, key, key) as Array<{ id: string }>
    const meta = this.db.prepare('SELECT source_leaf FROM asset_conversation_meta WHERE conversation_id = ?').get(conversationId) as { source_leaf: string } | undefined
    if (meta?.source_leaf) {
      const path = new Set(this.graph.path(conversationId, meta.source_leaf))
      return candidates.find(item => path.has(item.id)) ?? candidates[0]
    }
    return candidates[0]
  }
  suggestions(): AssetPromptSuggestion[] {
    const rows = this.db.prepare(`SELECT content, COUNT(*) AS uses, MAX(created_at) AS latest
      FROM (SELECT content, created_at FROM messages WHERE role = 'user' AND content != '' ORDER BY created_at DESC LIMIT 500)
      GROUP BY content ORDER BY latest DESC`).all() as Array<{ content: string; uses: number }>
    return rows.map(row => {
      const message = this.db.prepare("SELECT id, conversation_id FROM messages WHERE role = 'user' AND content = ? ORDER BY created_at DESC LIMIT 1")
        .get(row.content) as { id: string; conversation_id: string }
      return { content: row.content, title: Array.from(row.content.trim().split('\n')[0]).slice(0, 48).join(''),
        weight: promptWeight(row.content, row.uses), uses: row.uses, conversationId: message.conversation_id, messageId: message.id }
    }).filter(row => row.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 100)
  }
  searchConversations(query: string): string[] {
    if (!query.trim()) return []
    const rows = this.db.prepare(`SELECT DISTINCT c.id FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN asset_message_state s ON s.message_id = m.id
      WHERE instr(lower(c.title), lower(?)) > 0 OR instr(lower(m.content), lower(?)) > 0
      OR instr(lower(s.reasoning), lower(?)) > 0
      OR EXISTS (SELECT 1 FROM asset_revisions r WHERE r.message_id = m.id
        AND instr(lower(r.content || r.reasoning), lower(?)) > 0)
      OR EXISTS (SELECT 1 FROM asset_attachments a WHERE a.conversation_id = c.id
        AND instr(lower(a.name), lower(?)) > 0)`).all(query, query, query, query, query) as Array<{ id: string }>
    return rows.map(row => row.id)
  }
}
