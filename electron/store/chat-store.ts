// electron/store/chat-store.ts — 对话数据 SQLite 持久化（facade）
//
// 使用 better-sqlite3（native 模块）持久化：
//   - conversations: 对话会话（webview 抓取 + API 直连）
//   - messages: 对话消息
//   - login_traces: 平台登录痕迹（cookie 摘要 / 登录时间）
//   - window_traces: 窗口操作痕迹（创建/关闭/最大化/置顶等）
//
// 数据库路径：
//   - dev 模式：项目内 .app-data/chat.db（规避 TRAE 沙箱对 AppData\Roaming 的写入限制）
//   - 生产模式：app.getPath('userData')/chat.db
//
// 注意：better-sqlite3 是同步 API，所有方法都是阻塞调用，适合单次写入与小批量查询。
// 所有 CRUD 都在主进程执行，通过 IPC 暴露给渲染进程。
//
// 本文件作为 facade：仅保留建表（initSchema）、单例管理与 close，
// 具体业务委托给各职责子 store：
//   - ConversationStore：会话/消息 CRUD、导入导出、用量统计
//   - WindowTraceStore：窗口操作痕迹
//   - LoginTraceStore：平台登录痕迹
// 调用点（main.ts / handler.ts）通过 getChatStore().xxx() 访问，签名零修改。

import Database from 'better-sqlite3'
import type {
  Conversation,
  ConversationSourceType,
  ChatMessage,
  WindowTrace,
  WindowTraceAction,
  LoginTrace,
} from '../shared/types.js'
import {
  resolveSqlitePath,
  createSqliteDb,
  createSingletonHolder,
} from './store-paths.js'
import { WindowTraceStore } from './window-trace-store.js'
import { LoginTraceStore } from './login-trace-store.js'
import { ConversationStore } from './conversation-store.js'
import { UsageTraceStore } from './usage-trace-store.js'

/**
 * 对话 SQLite 持久化存储（facade）
 *
 * 所有方法同步执行（better-sqlite3 特性），在主进程内调用。
 * 渲染进程通过 IPC 触发对应方法。公开方法签名保持稳定，内部委托子 store 实现。
 */
export class ChatStore {
  private db: Database.Database
  private conversations: ConversationStore
  private windowTraces: WindowTraceStore
  private loginTraces: LoginTraceStore
  private usageTraces: UsageTraceStore

  constructor(dbPath?: string) {
    const finalPath = dbPath ?? resolveSqlitePath('chat.db')
    console.log('[chat-store] 数据库路径:', finalPath)
    // createSqliteDb 统一 new Database + WAL + foreign_keys + schema 初始化
    this.db = createSqliteDb(finalPath, (db) => this.initSchema(db))
    // 创建职责子 store（共享同一 db 实例，通过 facade 委托暴露）
    this.conversations = new ConversationStore(this.db)
    this.windowTraces = new WindowTraceStore(this.db)
    this.loginTraces = new LoginTraceStore(this.db)
    this.usageTraces = new UsageTraceStore(this.db)
  }

  /** 初始化表结构（幂等） */
  private initSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        url TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source_id);
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens INTEGER,
        created_at INTEGER NOT NULL,
        content_hash TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
      -- 去重索引：同一会话内相同内容哈希唯一，配合 INSERT OR IGNORE 防止重复入库
      -- 注意：CREATE UNIQUE INDEX 在 initSchema 的 v2 迁移分支中通过 try-catch + 去重重试创建，
      -- 此处不再重复创建，避免因重复数据导致整个 exec 块失败

      CREATE TABLE IF NOT EXISTS login_traces (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        platform TEXT,
        login_url TEXT,
        login_time INTEGER NOT NULL,
        session_data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_login_profile ON login_traces(profile_id);
      CREATE INDEX IF NOT EXISTS idx_login_time ON login_traces(login_time DESC);

      CREATE TABLE IF NOT EXISTS window_traces (
        id TEXT PRIMARY KEY,
        window_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_window ON window_traces(window_id);
      CREATE INDEX IF NOT EXISTS idx_trace_time ON window_traces(timestamp DESC);

      -- 全文搜索虚拟表（messages.content）—— 用 FTS5 增强搜索体验
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );
      -- 触发器保持 FTS 与主表同步
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `)

    // 版本化迁移框架：基于 SQLite 的 user_version pragma 跟踪 schema 版本。
    // 当前版本号 = 1（初始 schema 已通过上方 CREATE TABLE IF NOT EXISTS 建立）。
    // 未来新增字段/表时，在此追加 `if (currentVersion < N) { ... ALTER TABLE ... }` 分支，
    // 并将 TARGET_VERSION 提升至 N。现有 CREATE TABLE IF NOT EXISTS 语句保持不动。
    const currentVersion = db.pragma('user_version', { simple: true }) as number
    const TARGET_VERSION = 5
    if (currentVersion < 1) {
      // v1: 初始版本，无需迁移（表已通过 CREATE TABLE IF NOT EXISTS 创建）
      db.pragma(`user_version = 1`)
    }
    if (currentVersion < 2) {
      // v2: 新增 messages.content_hash 列 + 唯一索引（用于历史对话去重）
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查 table_info 判断列是否存在
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'content_hash')) {
        db.exec('ALTER TABLE messages ADD COLUMN content_hash TEXT')
      }
      // 创建唯一索引前先去重：清理已存在的重复 (conversation_id, content_hash) 数据
      // 保留每组中最早的一条（MIN(id)），避免 CREATE UNIQUE INDEX 因重复行失败
      try {
        db.exec(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_content_hash ON messages(conversation_id, content_hash)',
        )
      } catch (e) {
        // UNIQUE constraint failed：表中存在重复数据，去重后重试
        db.exec(`
          DELETE FROM messages WHERE id NOT IN (
            SELECT MIN(id) FROM messages
            WHERE content_hash IS NOT NULL
            GROUP BY conversation_id, content_hash
          ) AND content_hash IS NOT NULL
            AND (conversation_id, content_hash) IN (
              SELECT conversation_id, content_hash FROM messages
              WHERE content_hash IS NOT NULL
              GROUP BY conversation_id, content_hash
              HAVING COUNT(*) > 1
            )
        `)
        db.exec(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_content_hash ON messages(conversation_id, content_hash)',
        )
      }
      db.pragma(`user_version = 2`)
    }
    if (currentVersion < 3) {
      // v3: 新增 conversations.url 列（记录对话发生时的页面 URL，用于"启动时打开最近对话"）
      const cols = db
        .prepare('PRAGMA table_info(conversations)')
        .all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'url')) {
        db.exec('ALTER TABLE conversations ADD COLUMN url TEXT')
      }
      db.pragma(`user_version = 3`)
    }
    if (currentVersion < 4) {
      // v4: 新增使用统计与操作日志表
      // - app_starts：每次应用启动的时间戳、版本、便携模式、退出时间
      // - click_logs：带 data-name 属性的 UI 元素点击事件
      // 完全本地存储，用户可在设置中关闭（usageTrackingEnabled）
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_starts (
          id TEXT PRIMARY KEY,
          start_time INTEGER NOT NULL,
          end_time INTEGER,
          version TEXT,
          portable INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_app_start_time ON app_starts(start_time DESC);

        CREATE TABLE IF NOT EXISTS click_logs (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          element_name TEXT NOT NULL,
          window_type TEXT,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_click_time ON click_logs(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_click_element ON click_logs(element_name);
      `)
      db.pragma(`user_version = 4`)
    }
    if (currentVersion < 5) {
      // v5: 新增 messages.auto_grabbed 列（需求 6：标记消息是否由 webview 自动抓取入库）
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'auto_grabbed')) {
        db.exec('ALTER TABLE messages ADD COLUMN auto_grabbed INTEGER DEFAULT 0')
      }
      db.pragma(`user_version = 5`)
    }
    void TARGET_VERSION
  }

  // ===========================================================================
  // 会话 CRUD（委托 ConversationStore）
  // ===========================================================================

  /** 列出全部会话（按更新时间倒序）；传 sourceId 时按来源过滤 */
  listConversations(sourceId?: string): Conversation[] {
    return this.conversations.listConversations(sourceId)
  }

  /** 创建会话 */
  createConversation(
    sourceId: string,
    sourceType: ConversationSourceType,
    title: string,
    url?: string,
  ): Conversation {
    return this.conversations.createConversation(sourceId, sourceType, title, url)
  }

  /** 查询指定来源最近一条带 URL 的对话 URL（用于"启动时打开最近对话"） */
  getLastConversationUrl(sourceId: string): string | null {
    return this.conversations.getLastConversationUrl(sourceId)
  }

  /** 更新会话标题/更新时间 */
  touchConversation(id: string, title?: string): void {
    this.conversations.touchConversation(id, title)
  }

  /** 删除会话（消息级联删除由 FK ON DELETE CASCADE 处理，FTS 由 messages_ad 触发器自动清理） */
  deleteConversation(id: string): void {
    this.conversations.deleteConversation(id)
  }

  /** 清空所有对话（可选按 sourceId 过滤），返回删除的会话数） */
  clearAllConversations(sourceId?: string): number {
    return this.conversations.clearAllConversations(sourceId)
  }

  // ===========================================================================
  // 消息 CRUD（委托 ConversationStore）
  // ===========================================================================

  /** 列出会话消息（按时间升序） */
  listMessages(conversationId: string): ChatMessage[] {
    return this.conversations.listMessages(conversationId)
  }

  /** 保存单条消息 */
  saveMessage(
    msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): ChatMessage {
    return this.conversations.saveMessage(msg)
  }

  /**
   * 保存消息并智能合并（需求 5）：
   *   - 与会话内最近一条同 role 消息计算 Jaccard 相似度
   *   - 相似度 ≥ 0.85：UPDATE 现有消息内容
   *   - 完全相同（相似度 ≥ 0.999）：跳过
   *   - 否则：插入新记录
   */
  saveMessageWithMerge(
    msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): { merged: boolean; messageId: string; skipped: boolean } {
    return this.conversations.saveMessageWithMerge(msg)
  }

  /** 全文搜索消息（返回带会话标题） */
  search(
    query: string,
  ): Array<ChatMessage & { conversationTitle: string }> {
    return this.conversations.search(query)
  }

  /** 更新指定消息的 token 数（流式结束后回填用量） */
  updateMessageTokens(messageId: string, tokens: number): void {
    this.conversations.updateMessageTokens(messageId, tokens)
  }

  /** 更新消息内容 */
  updateMessage(messageId: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>): void {
    this.conversations.updateMessage(messageId, updates)
  }

  /** 删除单条消息 */
  deleteMessage(messageId: string): void {
    this.conversations.deleteMessage(messageId)
  }

  /** 7.1: 清理无效会话（缺失 provider/source 的脏数据），委托 ConversationStore */
  cleanupInvalidConversations(): { deletedCount: number } {
    return this.conversations.cleanupInvalidConversations()
  }

  // ===========================================================================
  // 导入导出（委托 ConversationStore）
  // ===========================================================================

  /**
   * 导出会话为 Markdown 或 JSON 字符串。
   * @param conversationId 会话 id
   * @param format 'md' | 'json'
   */
  exportConversation(conversationId: string, format: 'md' | 'json'): string {
    return this.conversations.exportConversation(conversationId, format)
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
    return this.conversations.importConversation(format, data, sourceId)
  }

  // ===========================================================================
  // 用量统计（委托 ConversationStore）
  // ===========================================================================

  /**
   * 用量统计：聚合 messages.tokens。
   * @param sourceId 可选，按会话来源（Provider id / Profile id）过滤
   * @returns { totalTokens, todayTokens, todayCount }
   */
  getUsageStats(sourceId?: string): { totalTokens: number; todayTokens: number; todayCount: number } {
    return this.conversations.getUsageStats(sourceId)
  }

  // ===========================================================================
  // 窗口操作痕迹（委托 WindowTraceStore）
  // ===========================================================================

  logWindowTrace(windowId: string, action: WindowTraceAction, detail?: unknown): void {
    this.windowTraces.logWindowTrace(windowId, action, detail)
  }

  listWindowTraces(windowId?: string, limit = 200): WindowTrace[] {
    return this.windowTraces.listWindowTraces(windowId, limit)
  }

  /** 清空窗口操作痕迹（可选按 windowId 过滤），返回删除的行数 */
  clearWindowTraces(windowId?: string): number {
    return this.windowTraces.clearWindowTraces(windowId)
  }

  // ===========================================================================
  // 登录痕迹（委托 LoginTraceStore）
  // ===========================================================================

  logLoginTrace(
    trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>,
  ): void {
    this.loginTraces.logLoginTrace(trace)
  }

  listLoginTraces(profileId?: string): LoginTrace[] {
    return this.loginTraces.listLoginTraces(profileId)
  }

  /** 清空登录痕迹（可选按 profileId 过滤），返回删除的行数 */
  clearLoginTraces(profileId?: string): number {
    return this.loginTraces.clearLoginTraces(profileId)
  }

  // ===========================================================================
  // 使用统计与操作日志（委托 UsageTraceStore）
  // ===========================================================================

  /** 记录应用启动时间戳，返回启动记录 id */
  logAppStart(): string {
    return this.usageTraces.logAppStart()
  }

  /** 记录应用退出时间（更新最近一条启动记录的 end_time） */
  logAppEnd(): void {
    this.usageTraces.logAppEnd()
  }

  /** 记录带 data-name 元素的点击日志 */
  logClick(elementName: string, windowType: string | null, detail?: unknown): void {
    this.usageTraces.logClick(elementName, windowType, detail)
  }

  /** 聚合频次统计（默认最近 30 天） */
  getFrequencyStats(rangeDays = 30) {
    return this.usageTraces.getFrequencyStats(rangeDays)
  }

  /** 清空所有使用统计与点击日志，返回删除的行数 */
  clearUsageTraces(): number {
    return this.usageTraces.clear()
  }

  /** 列出最近 N 条启动记录 */
  listAppStarts(limit = 50) {
    return this.usageTraces.listAppStarts(limit)
  }

  /** 列出最近 N 条点击日志 */
  listClickLogs(limit = 200) {
    return this.usageTraces.listClickLogs(limit)
  }

  /**
   * 清除自定义对话模块的数据：仅删除 source_type='custom' 的会话，
   * 消息由外键 ON DELETE CASCADE 级联删除。chat.db 与历史搜索/使用统计共享，
   * 禁止整库删除（依赖规则 3.3）。
   */
  clearCustomChatData(): number {
    const result = this.db
      .prepare(`DELETE FROM conversations WHERE source_type = 'custom'`)
      .run()
    return result.changes
  }

  // ===========================================================================
  // 关闭
  // ===========================================================================

  /**
   * 关闭 SQLite 连接并执行 WAL checkpoint。
   * 用于数据导出前确保 WAL 写回主 db（避免遗漏 -wal 文件中的数据），
   * 以及数据导入前释放文件锁。
   */
  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (e) {
      console.warn('[chat-store] WAL checkpoint 失败:', e)
    }
    try {
      this.db.close()
    } catch (e) {
      console.error('[chat-store] 关闭数据库失败:', e)
    }
  }
}

// 单例实例（在 main.ts 中初始化）
const chatStoreHolder = createSingletonHolder<ChatStore>(
  () => new ChatStore(),
  (s) => s.close(),
)

/** 初始化单例（必须在 app.whenReady 后调用） */
export function initChatStore(): ChatStore {
  return chatStoreHolder.get()
}

/** 获取单例（未初始化时抛错） */
export function getChatStore(): ChatStore {
  const s = chatStoreHolder.peek()
  if (!s) {
    throw new Error('[chat-store] 尚未初始化，请先调用 initChatStore()')
  }
  return s
}

/** 关闭单例（app before-quit 时调用） */
export function closeChatStore(): void {
  chatStoreHolder.close()
}
