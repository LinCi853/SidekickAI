import type Database from 'better-sqlite3'
import type { ChatMessage } from '../shared/chat.types.js'
import type { AssetConversationGraph, AssetGraphExport, AssetGraphNode, AssetObservation, AssetObservedMessage } from '../shared/ai-assets.types.js'

interface NodeRow { message_id: string; parent_id: string | null; source_key: string; version_key: string; branch_index: number | null; branch_count: number | null }
interface MetaRow { source_leaf: string | null; selected_leaf: string | null }
type Capture = (message: AssetObservedMessage, messageId?: string) => string
export class AssetGraphStore {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_nodes (
        message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT,
        source_key TEXT NOT NULL, version_key TEXT NOT NULL DEFAULT '', branch_index INTEGER, branch_count INTEGER,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS asset_node_parent ON asset_nodes(conversation_id, parent_id);
      CREATE TABLE IF NOT EXISTS asset_conversation_meta (
        conversation_id TEXT PRIMARY KEY, source_leaf TEXT, selected_leaf TEXT, imported_views INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_local_edits (
        message_id TEXT PRIMARY KEY, content TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS asset_exclusions (
        source_id TEXT NOT NULL, conversation_key TEXT NOT NULL, parent_id TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '', version_key TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(source_id, conversation_key, parent_id, source_key, version_key)
      );
      CREATE TABLE IF NOT EXISTS asset_view_events (
        conversation_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, event_id), FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `)
  }
  private rows(id: string): NodeRow[] {
    return this.db.prepare('SELECT * FROM asset_nodes WHERE conversation_id = ? ORDER BY rowid').all(id) as NodeRow[]
  }
  private meta(id: string): MetaRow {
    return (this.db.prepare('SELECT * FROM asset_conversation_meta WHERE conversation_id = ?').get(id) as MetaRow | undefined)
      ?? { source_leaf: null, selected_leaf: null }
  }
  ensure(id: string): void {
    const known = new Set(this.rows(id).map(node => node.message_id))
    const list = this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(id) as Array<{ id: string }>
    let parent = this.meta(id).source_leaf
    if (!known.size) parent = null
    for (const message of list) {
      if (known.has(message.id)) continue
      this.db.prepare('INSERT INTO asset_nodes (message_id, conversation_id, parent_id, source_key) VALUES (?, ?, ?, ?)')
        .run(message.id, id, parent, message.id)
      parent = message.id
    }
    this.db.prepare('INSERT OR IGNORE INTO asset_conversation_meta (conversation_id, source_leaf) VALUES (?, ?)').run(id, parent)
    if (list.some(message => !known.has(message.id))) this.db.prepare('UPDATE asset_conversation_meta SET source_leaf = ? WHERE conversation_id = ?').run(parent, id)
  }
  excluded(sourceId: string, conversationKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM asset_exclusions WHERE source_id = ? AND conversation_key = ? AND source_key = ''")
      .get(sourceId, conversationKey)
  }
  observe(id: string, sourceId: string, observation: AssetObservation, capture: Capture): Record<string, string> {
    this.ensure(id)
    const before = this.meta(id)
    const orderedSourcePath = this.path(id, before.source_leaf)
    const sourcePath = new Set(orderedSourcePath)
    const rows = this.rows(id)
    const knownPositions = observation.messages.map(message => orderedSourcePath.findIndex(key => {
      const node = rows.find(value => value.message_id === key)
      return node?.source_key === message.key
    })).filter(position => position >= 0)
    const omittedTail = observation.messages.length < orderedSourcePath.length && observation.messages.every((message, index) => {
      const node = rows.find(value => value.message_id === orderedSourcePath[index])
      const version = message.versionKey ?? ''
      return node?.source_key === message.key && (node.version_key === version || (!node.version_key && version
        && !!this.db.prepare('SELECT 1 FROM messages WHERE id = ? AND role = ? AND content = ?').get(node.message_id, message.role, message.content)))
    })
    const partial = observation.completePath === false || (knownPositions.length > 0
      && (knownPositions[0] > 0 || knownPositions.some((position, index) => index > 0 && position > knownPositions[index - 1] + 1))) || omittedTail
    let versionChanged = false
    let parent: string | null = null
    let last: string | null = null
    const messageIds: Record<string, string> = Object.create(null)
    for (const message of observation.messages) {
      const version = message.versionKey ?? ''
      const candidates = rows.filter(node => node.source_key === message.key && node.version_key === version)
      let node = partial && !versionChanged ? candidates.find(node => sourcePath.has(node.message_id)) ?? candidates[0]
        : candidates.find(node => node.parent_id === parent)
      if (!node && !partial) node = rows.find(row => row.source_key === row.message_id && row.parent_id === parent
        && !!this.db.prepare('SELECT 1 FROM messages WHERE id = ? AND role = ? AND content = ?').get(row.message_id, message.role, message.content))
      if (!node && version) {
        node = rows.find(value => value.source_key === message.key && !value.version_key
          && (partial ? sourcePath.has(value.message_id) : value.parent_id === parent)
          && !!this.db.prepare('SELECT 1 FROM messages WHERE id = ? AND role = ? AND content = ?').get(value.message_id, message.role, message.content))
      }
      const existingPosition = rows.find(value => value.source_key === message.key && sourcePath.has(value.message_id))
      if (!node && existingPosition && existingPosition.version_key !== version) versionChanged = true
      const messageParent: string | null = partial && node ? node.parent_id
        : parent ?? (partial ? existingPosition?.parent_id ?? before.source_leaf : null)
      const suppressed = this.db.prepare(`SELECT 1 FROM asset_exclusions WHERE source_id = ? AND conversation_key = ?
        AND parent_id = ? AND source_key = ? AND version_key = ?`).get(sourceId, observation.conversationKey, messageParent ?? '', message.key, version)
      if (suppressed) continue
      const key = node ? this.db.prepare('SELECT external_key FROM asset_message_state WHERE message_id = ?').get(node.message_id) as { external_key: string } | undefined : undefined
      const captured = capture({ ...message, key: key?.external_key ?? JSON.stringify([messageParent, message.key, version]) }, node?.message_id)
      messageIds[message.key] = captured
      this.db.prepare(`INSERT INTO asset_nodes (message_id, conversation_id, parent_id, source_key, version_key, branch_index, branch_count)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET
        source_key = excluded.source_key, version_key = excluded.version_key,
        branch_index = COALESCE(excluded.branch_index, branch_index), branch_count = COALESCE(excluded.branch_count, branch_count)`)
        .run(captured, id, messageParent, message.key, version, message.branchIndex ?? null, message.branchCount ?? null)
      parent = captured; last = captured
      if (!node) rows.push({ message_id: captured, parent_id: messageParent, source_key: message.key, version_key: version, branch_index: message.branchIndex ?? null, branch_count: message.branchCount ?? null })
    }
    if (last && (!partial || !before.source_leaf || last === before.source_leaf || versionChanged
      || this.path(id, last).includes(before.source_leaf))) {
      const selected = before.selected_leaf === before.source_leaf ? last : before.selected_leaf
      this.db.prepare('UPDATE asset_conversation_meta SET source_leaf = ?, selected_leaf = ? WHERE conversation_id = ?').run(last, selected, id)
    }
    return messageIds
  }
  path(id: string, leaf: string | null): string[] {
    const nodes = new Map(this.rows(id).map(node => [node.message_id, node]))
    const result: string[] = []
    const seen = new Set<string>()
    while (leaf && nodes.has(leaf) && !seen.has(leaf)) {
      seen.add(leaf); result.unshift(leaf); leaf = nodes.get(leaf)!.parent_id
    }
    return result
  }
  view(id: string, messages: ChatMessage[]): AssetConversationGraph {
    this.ensure(id)
    const meta = this.meta(id)
    const rows = this.rows(id)
    const nodes = new Map(rows.map(node => [node.message_id, node]))
    const edits = new Map((this.db.prepare(`SELECT e.* FROM asset_local_edits e JOIN messages m ON m.id = e.message_id WHERE m.conversation_id = ?`)
      .all(id) as Array<{ message_id: string; content: string }>).map(item => [item.message_id, item.content]))
    return { nodes: messages.map(message => {
      const node = nodes.get(message.id)!
      return { ...message, content: edits.get(message.id) ?? message.content, parentId: node.parent_id ?? undefined,
        sourceKey: node.source_key, versionKey: node.version_key, branchIndex: node.branch_index ?? undefined,
        branchCount: node.branch_count ?? undefined, locallyEdited: edits.has(message.id) } satisfies AssetGraphNode
    }), path: this.path(id, meta.selected_leaf ?? meta.source_leaf), sourcePath: this.path(id, meta.source_leaf) }
  }
  select(id: string, nodeId: string): void {
    this.ensure(id)
    const nodes = this.rows(id)
    if (!nodes.some(node => node.message_id === nodeId)) throw new Error('对话分支不存在')
    let leaf = nodeId
    const preferred = new Set(this.path(id, this.meta(id).source_leaf))
    const visited = new Set<string>()
    while (!visited.has(leaf)) {
      visited.add(leaf)
      const children = nodes.filter(node => node.parent_id === leaf)
      const child = children.find(node => preferred.has(node.message_id)) ?? children.at(-1)
      if (!child) break
      leaf = child.message_id
    }
    this.db.prepare('UPDATE asset_conversation_meta SET selected_leaf = ? WHERE conversation_id = ?').run(leaf, id)
  }
  viewEvent(id: string, eventId: string): void {
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return
    this.db.prepare('INSERT OR IGNORE INTO asset_view_events VALUES (?, ?, ?)').run(id, eventId, Date.now())
  }
  summaries(): Array<{ conversationId: string; views: number }> {
    return this.db.prepare(`SELECT c.id AS conversationId, COALESCE(m.imported_views, 0) + COUNT(e.event_id) AS views FROM conversations c
      LEFT JOIN asset_conversation_meta m ON m.conversation_id = c.id LEFT JOIN asset_view_events e ON e.conversation_id = c.id GROUP BY c.id`).all() as Array<{ conversationId: string; views: number }>
  }
  excludeConversation(id: string): void {
    const aliases = this.db.prepare('SELECT source_id, external_key FROM asset_conversation_keys WHERE conversation_id = ?').all(id) as Array<{ source_id: string; external_key: string }>
    for (const alias of aliases) this.db.prepare('INSERT OR IGNORE INTO asset_exclusions (source_id, conversation_key) VALUES (?, ?)').run(alias.source_id, alias.external_key)
  }
  excludeMessage(id: string): void {
    const node = this.db.prepare('SELECT * FROM asset_nodes WHERE message_id = ?').get(id) as (NodeRow & { conversation_id: string }) | undefined
    if (!node) return
    const aliases = this.db.prepare('SELECT source_id, external_key FROM asset_conversation_keys WHERE conversation_id = ?').all(node.conversation_id) as Array<{ source_id: string; external_key: string }>
    for (const alias of aliases) {
      this.db.prepare('UPDATE OR IGNORE asset_exclusions SET parent_id = ? WHERE source_id = ? AND conversation_key = ? AND parent_id = ?')
        .run(node.parent_id ?? '', alias.source_id, alias.external_key, id)
      this.db.prepare('INSERT OR IGNORE INTO asset_exclusions VALUES (?, ?, ?, ?, ?)')
        .run(alias.source_id, alias.external_key, node.parent_id ?? '', node.source_key, node.version_key)
    }
    this.db.prepare('UPDATE asset_nodes SET parent_id = ? WHERE parent_id = ? AND conversation_id = ?').run(node.parent_id, id, node.conversation_id)
    this.db.prepare(`UPDATE asset_conversation_meta SET source_leaf = CASE WHEN source_leaf = ? THEN ? ELSE source_leaf END,
      selected_leaf = CASE WHEN selected_leaf = ? THEN ? ELSE selected_leaf END WHERE conversation_id = ?`)
      .run(id, node.parent_id, id, node.parent_id, node.conversation_id)
  }
  export(id: string): AssetGraphExport {
    this.ensure(id)
    const edits = new Map((this.db.prepare(`SELECT e.* FROM asset_local_edits e JOIN messages m ON m.id = e.message_id WHERE m.conversation_id = ?`).all(id) as Array<{ message_id: string; content: string }>).map(item => [item.message_id, item.content]))
    const meta = this.meta(id)
    const exclusions = this.db.prepare(`SELECT DISTINCT e.parent_id, e.source_key, e.version_key FROM asset_exclusions e
      JOIN asset_conversation_keys k ON k.source_id = e.source_id AND k.external_key = e.conversation_key
      WHERE k.conversation_id = ? AND e.source_key != ''`).all(id) as Array<{ parent_id: string; source_key: string; version_key: string }>
    return { nodes: this.rows(id).map(node => ({ id: node.message_id, parentId: node.parent_id ?? undefined, sourceKey: node.source_key,
      versionKey: node.version_key, branchIndex: node.branch_index ?? undefined, branchCount: node.branch_count ?? undefined,
      localContent: edits.get(node.message_id) })), selectedLeaf: meta.selected_leaf ?? undefined, sourceLeaf: meta.source_leaf ?? undefined,
      views: this.summaries().find(item => item.conversationId === id)?.views ?? 0,
      exclusions: exclusions.map(item => ({ parentId: item.parent_id || undefined, sourceKey: item.source_key, versionKey: item.version_key })) }
  }
  import(id: string, sourceId: string, value: AssetGraphExport, mapped: Map<string, string>): void {
    if (!value || !Array.isArray(value.nodes) || value.nodes.length !== mapped.size) throw new Error('对话分支数据无效')
    const input = new Map(value.nodes.map(node => [node.id, node]))
    if (input.size !== value.nodes.length) throw new Error('对话分支标识重复')
    for (const node of value.nodes) {
      if (!mapped.has(node.id) || typeof node.sourceKey !== 'string' || typeof node.versionKey !== 'string') throw new Error('对话分支节点无效')
      const visited = new Set<string>([node.id]); let parent = node.parentId
      while (parent) {
        if (visited.has(parent) || !input.has(parent)) throw new Error('对话分支关系无效')
        visited.add(parent); parent = input.get(parent)!.parentId
      }
      this.db.prepare(`INSERT INTO asset_nodes (message_id, conversation_id, parent_id, source_key, version_key, branch_index, branch_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(mapped.get(node.id), id, node.parentId ? mapped.get(node.parentId) : null, node.sourceKey, node.versionKey, node.branchIndex ?? null, node.branchCount ?? null)
      if (node.localContent !== undefined) {
        if (typeof node.localContent !== 'string') throw new Error('本地修订内容无效')
        this.db.prepare('INSERT INTO asset_local_edits VALUES (?, ?)').run(mapped.get(node.id), node.localContent)
      }
    }
    for (const leaf of [value.selectedLeaf, value.sourceLeaf]) if (leaf && !mapped.has(leaf)) throw new Error('所选分支无效')
    if (!Number.isSafeInteger(value.views) || value.views < 0) throw new Error('浏览次数无效')
    this.db.prepare('INSERT INTO asset_conversation_meta VALUES (?, ?, ?, ?)').run(id, value.sourceLeaf ? mapped.get(value.sourceLeaf) : value.nodes.at(-1) ? mapped.get(value.nodes.at(-1)!.id) : null, value.selectedLeaf ? mapped.get(value.selectedLeaf) : null, value.views)
    this.db.prepare('INSERT INTO asset_conversation_keys VALUES (?, ?, ?)').run(sourceId, `import:${id}`, id)
    for (const item of value.exclusions ?? []) {
      if (typeof item.sourceKey !== 'string' || typeof item.versionKey !== 'string' || (item.parentId && !mapped.has(item.parentId))) throw new Error('消息排除记录无效')
      this.db.prepare('INSERT OR IGNORE INTO asset_exclusions VALUES (?, ?, ?, ?, ?)').run(sourceId, `import:${id}`, item.parentId ? mapped.get(item.parentId) : '', item.sourceKey, item.versionKey)
    }
  }
}
