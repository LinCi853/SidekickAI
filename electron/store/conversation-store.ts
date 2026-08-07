// electron/store/conversation-store.ts — 对话会话与消息 SQLite 持久化
//
// 从 chat-store.ts 拆分出来的职责子模块，负责 conversations / messages 两张表
// （以及 messages_fts 全文索引）的 CRUD、导入导出与 token 用量统计。
// 表结构（CREATE TABLE conversations / messages / messages_fts ... 及触发器）
// 仍由 ChatStore.initSchema 统一维护，因为建表顺序与外键/索引相关性较强，
// 集中管理风险更低。
//
// ChatStore 通过 facade 委托模式调用本类，调用点
// （getChatStore().listConversations() / saveMessage() / importConversation() 等）
// 完全无需修改。

import Database from 'better-sqlite3'
import { randomUUID, createHash } from 'crypto'
import type {
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatRole,
} from '../shared/types.js'

/** 全文搜索消息结果上限 */
const SEARCH_RESULT_LIMIT = 200

interface ConversationRow {
  id: string
  source_id: string
  source_type: string
  title: string
  created_at: number
  updated_at: number
  url: string | null
}

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  tokens: number | null
  created_at: number
  content_hash: string | null
  auto_grabbed: number | null
}

/** 将数据库行映射为 Conversation 对象 */
function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceType: r.source_type as ConversationSourceType,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: r.url ?? undefined,
  }
}

/** 将数据库行映射为 ChatMessage 对象 */
function rowToMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as ChatRole,
    content: r.content,
    tokens: r.tokens ?? undefined,
    createdAt: r.created_at,
    contentHash: r.content_hash ?? undefined,
    autoGrabbed: r.auto_grabbed === 1,
  }
}

/** 计算消息内容哈希（用于去重）：conversation_id + role + content 的 sha256 */
function computeContentHash(conversationId: string, role: string, content: string): string {
  return createHash('sha256').update(`${conversationId}\u0000${role}\u0000${content}`).digest('hex')
}

/**
 * 判断消息内容是否过短应被过滤（需求 5：过滤 <15 字符的单方面文本）。
 * 规则：
 *   1. 去除首尾空白后长度 < 15 字符 → 过滤
 *   2. 仅含标点/空白字符 → 过滤
 */
export function shouldFilterShortMessage(content: string): boolean {
  if (!content) return true
  const trimmed = content.trim()
  if (trimmed.length < 15) return true
  // 仅含标点/空白：中文标点 + 英文标点 + 空白
  if (/^[\s\u3000-\u303F\uFF00-\uFFEF\p{P}]+$/u.test(trimmed)) return true
  return false
}

/**
 * 计算两个字符串的 Jaccard 相似度（基于字符 bigram 集合）。
 * 用于需求 5 的轮次级合并：相似度 ≥ 0.85 时更新而非新增。
 */
function jaccardSimilarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2))
    }
    return set
  }
  const setA = bigrams(a)
  const setB = bigrams(b)
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const bg of setA) {
    if (setB.has(bg)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 合并相似度阈值：≥ 此值时更新已有消息而非新增 */
const MERGE_SIMILARITY_THRESHOLD = 0.85

/** 安全解析 JSON 字符串，失败时抛业务错误 */
function parseJsonSafe(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch (e) {
    throw new Error(`JSON 解析失败: ${(e as Error).message}`)
  }
}

/** 断言值为合法对象（非 null/数组） */
function assertObject(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('导入数据不是合法对象')
  }
}

/**
 * 对话会话与消息 SQLite 持久化存储
 *
 * 所有方法同步执行（better-sqlite3 特性），在主进程内调用。
 * 由 ChatStore 持有实例并通过 facade 委托暴露。
 */
export class ConversationStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  // ===========================================================================
  // 会话 CRUD
  // ===========================================================================

  /** 列出全部会话（按更新时间倒序）；传 sourceId 时按来源过滤 */
  listConversations(sourceId?: string): Conversation[] {
    if (sourceId) {
      const rows = this.db
        .prepare('SELECT * FROM conversations WHERE source_id = ? ORDER BY updated_at DESC')
        .all(sourceId) as ConversationRow[]
      return rows.map(rowToConversation)
    }
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as ConversationRow[]
    return rows.map(rowToConversation)
  }

  /** 创建会话 */
  createConversation(
    sourceId: string,
    sourceType: ConversationSourceType,
    title: string,
    url?: string,
  ): Conversation {
    const now = Date.now()
    const conv: Conversation = {
      id: randomUUID(),
      sourceId,
      sourceType,
      title: title || '新对话',
      createdAt: now,
      updatedAt: now,
      url: url || undefined,
    }
    this.db
      .prepare(
        'INSERT INTO conversations (id, source_id, source_type, title, created_at, updated_at, url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        conv.id,
        conv.sourceId,
        conv.sourceType,
        conv.title,
        conv.createdAt,
        conv.updatedAt,
        url ?? null,
      )
    return conv
  }

  /** 查询指定来源最近一条带 URL 的对话 URL（用于"启动时打开最近对话"） */
  getLastConversationUrl(sourceId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT url FROM conversations WHERE source_id = ? AND url IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
      )
      .get(sourceId) as { url: string } | undefined
    return row?.url ?? null
  }

  /** 更新会话标题/更新时间 */
  touchConversation(id: string, title?: string): void {
    const now = Date.now()
    if (title) {
      this.db
        .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
        .run(title, now, id)
    } else {
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id)
    }
  }

  /** 删除会话（消息级联删除由 FK ON DELETE CASCADE 处理，FTS 由 messages_ad 触发器自动清理） */
  deleteConversation(id: string): void {
    // 使用事务保证原子性：删除 conversations → CASCADE 删除 messages → messages_ad 触发器清理 FTS
    // 不再手动 DELETE messages_fts，避免对已不存在的 rowid 执行 'delete' 导致 FTS5 索引损坏
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })()
  }

  /** 清空所有对话（可选按 sourceId 过滤），返回删除的会话数） */
  clearAllConversations(sourceId?: string): number {
    let count = 0
    this.db.transaction(() => {
      if (sourceId) {
        const result = this.db
          .prepare('DELETE FROM conversations WHERE source_id = ?')
          .run(sourceId)
        count = result.changes
      } else {
        const result = this.db.prepare('DELETE FROM conversations').run()
        count = result.changes
      }
    })()
    return count
  }

  /**
   * 清理无效对话数据：
   * 1) 只有 user 消息无 assistant 回复的对话（无任何 role='assistant' 消息则删除整个对话）
   * 2) 所有消息内容均匹配「要求登录」类关键词的对话（登录/login/sign in/请登录/log in，忽略大小写）
   *
   * 删除 conversation 时由 FK ON DELETE CASCADE 级联删除其 messages，
   * FTS 索引由 messages_ad 触发器自动清理（与 deleteConversation 一致）。
   *
   * @returns { deletedCount: number } 删除的对话数量
   */
  cleanupInvalidConversations(): { deletedCount: number } {
    let deletedCount = 0

    // 「要求登录」类关键词正则（忽略大小写）
    const loginKeywordRe = /登录|login|sign\s*in|请登录|log\s*in/i

    this.db.transaction(() => {
      // 取出全部对话 id（逐个判定，数据量可控）
      const convs = this.db
        .prepare('SELECT id FROM conversations')
        .all() as Array<{ id: string }>

      const toDelete: string[] = []

      for (const c of convs) {
        const rows = this.db
          .prepare('SELECT role, content FROM messages WHERE conversation_id = ?')
          .all(c.id) as Array<{ role: string; content: string }>

        // 无消息的空对话也视为无效
        if (rows.length === 0) {
          toDelete.push(c.id)
          continue
        }

        // 规则 1：无任何 assistant 回复 → 删除
        const hasAssistant = rows.some((r) => r.role === 'assistant')
        if (!hasAssistant) {
          toDelete.push(c.id)
          continue
        }

        // 规则 2：所有消息内容均匹配「要求登录」类关键词 → 删除
        const allLoginRelated = rows.every((r) => loginKeywordRe.test(r.content || ''))
        if (allLoginRelated) {
          toDelete.push(c.id)
        }
      }

      // 批量删除（CASCADE 自动清理 messages + FTS 触发器自动清理索引）
      for (const id of toDelete) {
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
      }
      deletedCount = toDelete.length
    })()

    return { deletedCount: deletedCount }
  }

  // ===========================================================================
  // 消息 CRUD
  // ===========================================================================

  /** 列出会话消息（按时间升序） */
  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as MessageRow[]
    return rows.map(rowToMessage)
  }

  /** 保存单条消息（内容哈希去重：同一会话内相同 role+content 不重复入库） */
  saveMessage(
    msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): ChatMessage {
    const full: ChatMessage = {
      id: msg.id ?? randomUUID(),
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      tokens: msg.tokens,
      createdAt: msg.createdAt ?? Date.now(),
      contentHash: computeContentHash(msg.conversationId, msg.role, msg.content),
      autoGrabbed: msg.autoGrabbed,
    }
    // INSERT OR IGNORE：命中 (conversation_id, content_hash) 唯一索引时跳过，防止重复抓取入库
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO messages (id, conversation_id, role, content, tokens, created_at, content_hash, auto_grabbed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id,
        full.conversationId,
        full.role,
        full.content,
        full.tokens ?? null,
        full.createdAt,
        full.contentHash ?? null,
        full.autoGrabbed ? 1 : 0,
      )
    // 无论是否新插入都更新会话时间（result.changes === 0 表示重复跳过）
    this.touchConversation(full.conversationId)
    void result
    return full
  }

  /**
   * 保存消息并智能合并（需求 5）：
   *   - 与会话内最近一条同 role 消息计算 Jaccard 相似度
   *   - 相似度 ≥ 0.85：UPDATE 现有消息内容（保留原 createdAt，更新 content/contentHash/auto_grabbed）
   *   - 相似度 < 0.85：调用 saveMessage 插入新记录
   *   - 完全相同（相似度 = 1）：跳过，返回已有消息 id（视为重复）
   * @returns { merged: boolean; messageId: string; skipped?: boolean }
   */
  saveMessageWithMerge(
    msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): { merged: boolean; messageId: string; skipped: boolean } {
    // 查询同会话内最近一条同 role 消息
    const recent = this.db
      .prepare(
        'SELECT id, content FROM messages WHERE conversation_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(msg.conversationId, msg.role) as { id: string; content: string } | undefined

    if (recent) {
      const sim = jaccardSimilarity(msg.content, recent.content)
      if (sim >= MERGE_SIMILARITY_THRESHOLD) {
        // 完全相同：跳过（数据库唯一索引也会拦截，但这里提前返回避免触发 trigger）
        if (sim >= 0.999) {
          this.touchConversation(msg.conversationId)
          return { merged: false, messageId: recent.id, skipped: true }
        }
        // 高相似度：UPDATE 现有消息（保留原 id 与 createdAt，更新 content/contentHash/auto_grabbed）
        const newHash = computeContentHash(msg.conversationId, msg.role, msg.content)
        this.db
          .prepare(
            'UPDATE messages SET content = ?, content_hash = ?, auto_grabbed = ? WHERE id = ?',
          )
          .run(msg.content, newHash, msg.autoGrabbed ? 1 : 0, recent.id)
        this.touchConversation(msg.conversationId)
        return { merged: true, messageId: recent.id, skipped: false }
      }
    }
    // 无相似消息：插入新记录
    const saved = this.saveMessage(msg)
    return { merged: false, messageId: saved.id, skipped: false }
  }

  /** 全文搜索消息（返回带会话标题） */
  search(
    query: string,
  ): Array<ChatMessage & { conversationTitle: string }> {
    const trimmed = query.trim()
    if (!trimmed) return []
    // FTS5 MATCH 语法：使用简单词组匹配；特殊字符用双引号包裹
    const safeQuery = `"${trimmed.replace(/"/g, '""')}"`
    const rows = this.db
      .prepare(
        `SELECT m.id, m.conversation_id, m.role, m.content, m.tokens, m.created_at, m.content_hash,
                c.title AS conversation_title
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
         ORDER BY m.created_at DESC
         LIMIT ${SEARCH_RESULT_LIMIT}`,
      )
      .all(safeQuery) as Array<MessageRow & { conversation_title: string }>
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as ChatRole,
      content: r.content,
      tokens: r.tokens ?? undefined,
      createdAt: r.created_at,
      contentHash: r.content_hash ?? undefined,
      conversationTitle: r.conversation_title,
    }))
  }

  /** 更新指定消息的 token 数（流式结束后回填用量） */
  updateMessageTokens(messageId: string, tokens: number): void {
    this.db
      .prepare('UPDATE messages SET tokens = ? WHERE id = ?')
      .run(tokens, messageId)
  }

  /** 更新消息内容 */
  updateMessage(messageId: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>): void {
    const fields: string[] = []
    const values: unknown[] = []
    if (updates.content !== undefined) {
      fields.push('content = ?')
      values.push(updates.content)
    }
    if (updates.role !== undefined) {
      fields.push('role = ?')
      values.push(updates.role)
    }
    if (fields.length === 0) return
    values.push(messageId)
    this.db
      .prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values)
    // 更新会话更新时间
    const row = this.db
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(messageId) as { conversation_id: string } | undefined
    if (row) this.touchConversation(row.conversation_id)
  }

  /** 删除单条消息 */
  deleteMessage(messageId: string): void {
    const row = this.db
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(messageId) as { conversation_id: string } | undefined
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    if (row) this.touchConversation(row.conversation_id)
  }

  // ===========================================================================
  // 导入导出
  // ===========================================================================

  /**
   * 导出会话为 Markdown 或 JSON 字符串。
   * @param conversationId 会话 id
   * @param format 'md' | 'json'
   */
  exportConversation(conversationId: string, format: 'md' | 'json'): string {
    const convRow = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as ConversationRow | undefined
    if (!convRow) throw new Error(`会话不存在: ${conversationId}`)
    const conv = rowToConversation(convRow)
    const messages = this.listMessages(conversationId)

    if (format === 'json') {
      return JSON.stringify(
        {
          id: conv.id,
          title: conv.title,
          sourceId: conv.sourceId,
          sourceType: conv.sourceType,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messages: messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            tokens: m.tokens ?? null,
            createdAt: m.createdAt,
            autoGrabbed: m.autoGrabbed ?? false,
          })),
        },
        null,
        2,
      )
    }

    // Markdown：标题 + 元信息 + 逐条消息
    const lines: string[] = []
    lines.push(`# ${conv.title}`)
    lines.push('')
    lines.push(`> 来源: ${conv.sourceType} (${conv.sourceId})`)
    lines.push(`> 创建: ${new Date(conv.createdAt).toLocaleString('zh-CN')}`)
    lines.push(`> 更新: ${new Date(conv.updatedAt).toLocaleString('zh-CN')}`)
    lines.push('')
    lines.push('---')
    lines.push('')
    for (const m of messages) {
      const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
      const autoTag = m.autoGrabbed ? ' [自动抓取]' : ''
      lines.push(`## ${roleLabel}${autoTag}`)
      lines.push('')
      lines.push(m.content)
      if (m.tokens != null) {
        lines.push('')
        lines.push(`<sub>tokens: ${m.tokens}</sub>`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  /**
   * 导入对话（从 JSON / Markdown / DeepSeek 导出格式）。
   * @param format 'json' 为本软件格式 | 'deepseek' 为 DeepSeek 导出的 JSON | 'md' 为 Markdown
   * @param data 导入的文本内容
   * @param sourceId 导入后归属的来源 id（profile id）
   * @returns 新建的会话
   */
  importConversation(
    format: 'json' | 'deepseek' | 'md',
    data: string,
    sourceId: string,
  ): Conversation {
    const now = Date.now()

    if (format === 'json') {
      // 本软件 JSON 格式（与 exportConversation('json') 对应）
      const parsed = parseJsonSafe(data)
      assertObject(parsed)
      const messages = (Array.isArray(parsed.messages) ? parsed.messages : []) as Array<{
        role: string
        content: string
        createdAt?: number
      }>
      const conv = this.createConversation(
          sourceId,
          'webview',
          (parsed.title as string) || '导入的对话',
        )
      for (const m of messages) {
        if (!m.role || !m.content) continue
        this.saveMessage({
          conversationId: conv.id,
          role: (m.role as ChatRole) || 'assistant',
          content: String(m.content),
          createdAt: m.createdAt,
        })
      }
      return conv
    }

    if (format === 'deepseek') {
      // DeepSeek 导出的 JSON 格式（常见结构：id/title/messages 数组）
      // 经联网搜索确认 DeepSeek 导出格式：顶层含 conversation_id/title/name + messages 数组，
      // 每条消息含 role(user/assistant) + content + 可选 timestamp（字符串或数字）。
      // 部分第三方导出工具可能使用 sender/from 替代 role，此处一并兼容。
      const parsed = parseJsonSafe(data)
      assertObject(parsed)
      // 兼容多种 DeepSeek 的不同导出结构
      const dataField = parsed.data as Record<string, unknown> | undefined
      const msgList = (parsed.messages || dataField?.messages || []) as Array<{
        role?: string
        sender?: string
        from?: string
        content?: string
        text?: string
        timestamp?: string | number
        created_at?: string | number
      }>
      const title =
        (parsed.title as string) ||
        (parsed.name as string) ||
        (parsed.conversation_id as string) ||
        'DeepSeek 导入对话'
      const conv = this.createConversation(sourceId, 'webview', title)
      for (const m of msgList) {
        // 字段名兼容：role / sender / from（部分导出工具使用非标准字段名）
        const rawRole = m.role || m.sender || m.from || ''
        const role = rawRole === 'user' ? 'user' : 'assistant'
        const content = m.content || m.text || ''
        if (!content) continue
        // 时间戳兼容：timestamp / created_at，支持字符串日期与数字毫秒
        let createdAt: number | undefined
        const ts = m.timestamp ?? m.created_at
        if (ts != null) {
          if (typeof ts === 'number') {
            createdAt = ts
          } else {
            const tsMs = Date.parse(String(ts))
            if (!Number.isNaN(tsMs)) createdAt = tsMs
          }
        }
        this.saveMessage({
          conversationId: conv.id,
          role,
          content: String(content),
          createdAt,
        })
      }
      return conv
    }

    // Markdown 格式：解析
    const lines = data.split('\n')
    let title = '导入的对话'
    const messages: Array<{ role: ChatRole; content: string }> = []
    let currentRole: ChatRole | null = null
    let currentContent: string[] = []

    for (const line of lines) {
      if (line.startsWith('# ')) {
        title = line.slice(2).trim()
        continue
      }
      if (/^##\s*(用户|user|🧑|👤|User)/.test(line)) {
        if (currentRole && currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() })
        }
        currentRole = 'user'
        currentContent = []
        continue
      }
      if (/^##\s*(助手|assistant|bot|AI|🤖|Assistant)/.test(line)) {
        if (currentRole && currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n').trim() })
        }
        currentRole = 'assistant'
        currentContent = []
        continue
      }
      if (currentRole) {
        currentContent.push(line)
      }
    }
    if (currentRole && currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent.join('\n').trim() })
    }

    const conv = this.createConversation(sourceId, 'webview', title)
    for (const m of messages) {
      this.saveMessage({
        conversationId: conv.id,
        role: m.role,
        content: m.content,
      })
    }
    return conv
  }

  // ===========================================================================
  // 用量统计
  // ===========================================================================

  /**
   * 用量统计：聚合 messages.tokens。
   * @param sourceId 可选，按会话来源（Provider id / Profile id）过滤
   * @returns { totalTokens, todayTokens, todayCount }
   */
  getUsageStats(sourceId?: string): { totalTokens: number; todayTokens: number; todayCount: number } {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayMs = todayStart.getTime()

    if (sourceId) {
      const totalRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(m.tokens), 0) AS t
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.source_id = ? AND m.tokens IS NOT NULL`,
        )
        .get(sourceId) as { t: number }
      const todayRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(m.tokens), 0) AS t, COUNT(*) AS n
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.source_id = ? AND m.tokens IS NOT NULL AND m.created_at >= ?`,
        )
        .get(sourceId, todayMs) as { t: number; n: number }
      return { totalTokens: totalRow.t, todayTokens: todayRow.t, todayCount: todayRow.n }
    }

    const totalRow = this.db
      .prepare('SELECT COALESCE(SUM(tokens), 0) AS t FROM messages WHERE tokens IS NOT NULL')
      .get() as { t: number }
    const todayRow = this.db
      .prepare(
        'SELECT COALESCE(SUM(tokens), 0) AS t, COUNT(*) AS n FROM messages WHERE tokens IS NOT NULL AND created_at >= ?',
      )
      .get(todayMs) as { t: number; n: number }
    return { totalTokens: totalRow.t, todayTokens: todayRow.t, todayCount: todayRow.n }
  }
}
