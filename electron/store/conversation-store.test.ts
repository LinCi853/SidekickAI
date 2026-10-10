// cleanupInvalidConversations 行为回归测试：单次聚合扫描的判定结果必须与
// 原"逐会话加载全部消息 + 正则"的实现一致（空会话、无 assistant 回复、登录墙）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ConversationStore } from './conversation-store'

describe('cleanupInvalidConversations', () => {
  let db: Database.Database
  let store: ConversationStore
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON')
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);`)
    store = new ConversationStore(db)
  })
  afterEach(() => db.close())

  const addConversation = (id: string, messages: Array<[role: string, content: string]>) => {
    db.prepare('INSERT INTO conversations (id) VALUES (?)').run(id)
    for (const [index, [role, content]] of messages.entries()) {
      db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)')
        .run(`${id}-m${index}`, id, role, content)
    }
  }
  const remaining = () => (db.prepare('SELECT id FROM conversations ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)

  it('deletes empty and assistant-less conversations without loading message bodies', () => {
    addConversation('empty', [])
    addConversation('user-only', [['user', '你好']])
    addConversation('healthy', [['user', '你好'], ['assistant', '你好呀']])
    expect(store.cleanupInvalidConversations()).toEqual({ deletedCount: 2 })
    expect(remaining()).toEqual(['healthy'])
  })

  it('deletes login-wall conversations and keeps mixed or substantive ones', () => {
    addConversation('login-wall', [['user', '请登录后继续'], ['assistant', 'Login required'], ['assistant', '请 登录']])
    addConversation('mixed', [['user', '请登录后继续'], ['assistant', '已经进入系统，下面是正文回答']])
    addConversation('healthy', [['user', '讲解一下 login 系统的设计'], ['assistant', '好的，通常包含认证与会话管理']])
    expect(store.cleanupInvalidConversations()).toEqual({ deletedCount: 1 })
    expect(remaining()).toEqual(['healthy', 'mixed'])
  })

  it('cascades message deletion with the conversation', () => {
    addConversation('user-only', [['user', '你好']])
    addConversation('healthy', [['user', '你好'], ['assistant', '你好呀']])
    store.cleanupInvalidConversations()
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 })
  })
})
