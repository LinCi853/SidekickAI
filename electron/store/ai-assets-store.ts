import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import type { ChatMessage } from '../shared/chat.types.js'
import type {
  AssetAttachment, AssetAttachmentInput, AssetMessageDetail, AssetMessageStatus,
  AssetObservation, AssetObservedMessage, AssetPromptSuggestion, AssetRevision,
  AssetSource, AssetTextUsage,
} from '../shared/ai-assets.types.js'
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
  }

  clearData(settingsPath: string): void {
    this.db.prepare('ATTACH DATABASE ? AS asset_settings').run(settingsPath)
    try {
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM conversations').run()
        this.db.prepare("UPDATE asset_settings.prompts SET value = json_set(value, '$.prompts', json('[]')) WHERE key = '__data__'").run()
        this.db.prepare("UPDATE asset_settings.injection_history SET value = json_set(value, '$.records', json('[]')) WHERE key = '__data__'").run()
      })()
    } finally { this.db.exec('DETACH DATABASE asset_settings') }
  }

  conversation(source: AssetSource, observation: Omit<AssetObservation, 'messages'>): string {
    const known = this.db.prepare('SELECT conversation_id FROM asset_conversation_keys WHERE source_id = ? AND external_key = ?')
      .get(source.id, observation.conversationKey) as { conversation_id: string } | undefined
    if (known) return known.conversation_id
    const legacy = observation.url ? this.db.prepare(`SELECT id FROM conversations
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

  observe(source: AssetSource, observation: AssetObservation): { conversationId: string } {
    return this.db.transaction(() => {
      if (observation.previousConversationKey?.startsWith('document:') && !observation.conversationKey.startsWith('document:')) {
        const draft = this.db.prepare('SELECT conversation_id FROM asset_conversation_keys WHERE source_id = ? AND external_key = ?')
          .get(source.id, observation.previousConversationKey) as { conversation_id: string } | undefined
        const matches = draft && observation.messages.some(message => !/:\d+$/.test(message.key)
          && this.db.prepare(`SELECT 1 FROM asset_message_state s JOIN messages m ON m.id = s.message_id
            WHERE m.conversation_id = ? AND s.external_key = ?`).get(draft.conversation_id, message.key))
        if (matches) this.db.prepare('INSERT OR IGNORE INTO asset_conversation_keys VALUES (?, ?, ?)')
          .run(source.id, observation.conversationKey, draft.conversation_id)
      }
      const conversationId = this.conversation(source, observation)
      for (const message of observation.messages) this.capture(conversationId, message)
      if (observation.messages.length) this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
        .run(observation.title || '新对话', Date.now(), conversationId)
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
    const signature = digest(JSON.stringify([observed.content, reasoning, status]))
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
    this.db.prepare("UPDATE asset_message_state SET status = 'stopped' WHERE status = 'streaming'").run()
  }

  editMessage(id: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>): void {
    const message = this.db.prepare('SELECT m.*, s.external_key FROM messages m LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.id = ?')
      .get(id) as { conversation_id: string; content: string; role: ChatMessage['role']; external_key?: string } | undefined
    if (!message) return
    const key = message.external_key ?? id
    this.db.transaction(() => {
      if (!message.external_key) this.captureMessage(message.conversation_id, { key, role: message.role, content: message.content }, id)
      this.captureMessage(message.conversation_id, { key, role: updates.role ?? message.role, content: updates.content ?? message.content }, id)
      if (updates.role) this.db.prepare('UPDATE messages SET role = ? WHERE id = ?').run(updates.role, id)
    })()
  }

  details(conversationId: string): AssetMessageDetail[] {
    const rows = this.db.prepare(`SELECT m.id, m.content, m.role, s.* FROM messages m
      LEFT JOIN asset_message_state s ON s.message_id = m.id WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid`)
      .all(conversationId) as Array<MessageState & { id: string; content: string; role: string }>
    return rows.map(row => ({
      messageId: row.id, reasoning: row.reasoning ?? '', status: row.status ?? 'complete',
      inputCharacters: row.input_characters ?? (row.role !== 'assistant' ? countCharacters(row.content) : 0),
      reasoningCharacters: row.reasoning_characters ?? 0,
      outputCharacters: row.output_characters ?? (row.role === 'assistant' ? countCharacters(row.content) : 0),
      revisions: (this.db.prepare('SELECT * FROM asset_revisions WHERE message_id = ? ORDER BY captured_at, rowid').all(row.id) as Array<{
        id: string; message_id: string; content: string; reasoning: string; status: AssetMessageStatus; captured_at: number
      }>).map(r => ({ id: r.id, messageId: r.message_id, content: r.content, reasoning: r.reasoning, status: r.status, capturedAt: r.captured_at } satisfies AssetRevision)),
    }))
  }

  usage(sourceId?: string): AssetTextUsage {
    const row = this.db.prepare(`SELECT COALESCE(SUM(input_characters), 0) AS input,
      COALESCE(SUM(reasoning_characters), 0) AS reasoning, COALESCE(SUM(output_characters), 0) AS output
      FROM asset_message_state s JOIN messages m ON m.id = s.message_id
      JOIN conversations c ON c.id = m.conversation_id WHERE (? IS NULL OR c.source_id = ?)`)
      .get(sourceId ?? null, sourceId ?? null) as { input: number; reasoning: number; output: number }
    const legacy = this.db.prepare(`SELECT role, content FROM messages
      WHERE NOT EXISTS (SELECT 1 FROM asset_message_state WHERE message_id = messages.id)
      AND conversation_id IN (SELECT id FROM conversations WHERE source_type != 'freeze-snapshot')
      AND (? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE source_id = ?))`)
      .all(sourceId ?? null, sourceId ?? null) as Array<{ role: string; content: string }>
    for (const message of legacy) row[message.role === 'assistant' ? 'output' : 'input'] += countCharacters(message.content)
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const today = this.db.prepare(`SELECT COALESCE(SUM(input_characters + reasoning_characters + output_characters), 0) AS count
      FROM asset_text_events e JOIN messages m ON m.id = e.message_id
      JOIN conversations c ON c.id = m.conversation_id WHERE captured_at >= ? AND (? IS NULL OR c.source_id = ?)`)
      .get(start.getTime(), sourceId ?? null, sourceId ?? null) as { count: number }
    return { inputCharacters: row.input, reasoningCharacters: row.reasoning, outputCharacters: row.output,
      totalCharacters: row.input + row.reasoning + row.output, todayCharacters: today.count }
  }

  beginAttachment(source: AssetSource, input: AssetAttachmentInput, knownConversationId?: string): AssetAttachment {
    const conversationId = knownConversationId ?? this.conversation(source, input)
    const known = this.db.prepare('SELECT * FROM asset_attachments WHERE conversation_id = ? AND external_key = ?')
      .get(conversationId, input.externalKey) as AttachmentRow | undefined
    if (known) return attachment(known)
    const message = input.messageKey ? this.db.prepare(`SELECT m.id FROM messages m JOIN asset_message_state s
      ON s.message_id = m.id WHERE m.conversation_id = ? AND s.external_key = ?`).get(conversationId, input.messageKey) as { id: string } | undefined : undefined
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
  importDetails(conversationId: string, sourceId: string, messages: Array<{ id?: string; asset?: AssetMessageDetail }>, files: AssetAttachment[]): void {
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
      for (const revision of value.revisions ?? []) {
        if (typeof revision.content !== 'string' || typeof revision.reasoning !== 'string') throw new Error('Invalid asset revision')
        this.db.prepare('INSERT INTO asset_revisions VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), id, revision.content, revision.reasoning, revision.status, count(revision.capturedAt))
      }
    })
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
    const message = this.db.prepare(`SELECT m.id FROM messages m JOIN asset_message_state s ON s.message_id = m.id
      WHERE m.conversation_id = ? AND s.external_key = ?`).get(conversationId, messageKey) as { id: string } | undefined
    if (!message) throw new Error('Attachment message not found')
    this.db.transaction(() => {
      for (const id of ids) this.db.prepare('UPDATE asset_attachments SET conversation_id = ?, message_id = ? WHERE id = ? AND source_id = ?')
        .run(conversationId, message.id, id, sourceId)
    })()
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
