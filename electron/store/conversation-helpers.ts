// electron/store/conversation-helpers.ts — 对话存储的纯辅助函数
//
// 从 conversation-store.ts 拆分出来的无状态部分：数据库行映射、内容哈希、
// 相似度合并判定与导入解析工具。全部为纯函数/常量，不持有数据库连接。

import { createHash } from 'crypto'
import type {
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatRole,
} from '../shared/types.js'

/** 全文搜索消息结果上限 */
export const SEARCH_RESULT_LIMIT = 200

export interface ConversationRow {
  id: string
  source_id: string
  source_type: string
  title: string
  created_at: number
  updated_at: number
  url: string | null
}

export interface MessageRow {
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
export function rowToConversation(r: ConversationRow): Conversation {
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
export function rowToMessage(r: MessageRow): ChatMessage {
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
export function computeContentHash(conversationId: string, role: string, content: string): string {
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
export function jaccardSimilarity(a: string, b: string): number {
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
export const MERGE_SIMILARITY_THRESHOLD = 0.85

/** 安全解析 JSON 字符串，失败时抛业务错误 */
export function parseJsonSafe(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch (e) {
    throw new Error(`JSON 解析失败: ${(e as Error).message}`)
  }
}

/** 断言值为合法对象（非 null/数组） */
export function assertObject(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('导入数据不是合法对象')
  }
}
