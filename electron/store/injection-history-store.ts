// electron/store/injection-history-store.ts — 注入历史持久化（需求 2：注入预览 + Jaccard 去重）
//
// 持久化到 SQLite settings.db（injection_history 表，createSqliteJsonStore）。
// 提供注入日志记录、最近 N 条查询、Jaccard 相似度查找、清空操作。
// 最多保留 200 条，超出按时间淘汰（最旧的先删）。

import { randomUUID } from 'crypto'
import { createSqliteJsonStore } from './module-state-store.js'

/** 单条注入历史记录 */
export interface InjectionRecord {
  /** 唯一标识 */
  id: string
  /** 组合后的完整注入文本（{{body}} 占位符已替换为实际内容） */
  composedText: string
  /** 关联的提示词模板 id（可选） */
  templateId?: string
  /** 注入目标窗口 id（主窗口 / 提示词库窗口等） */
  windowId: string
  /** 注入时间戳 */
  createdAt: number
}

/** Jaccard 相似度查找结果（含相似度分数） */
export interface SimilarInjectionResult extends InjectionRecord {
  /** 与查询文本的 Jaccard 相似度（0~1） */
  similarity: number
}

const MAX_RECORDS = 200

const store = createSqliteJsonStore<{ records: InjectionRecord[]; version: number }>({
  tableName: 'injection_history',
  legacyName: 'injection-history',
  defaults: { records: [], version: 1 },
})

/**
 * 字符 bigram 集合的 Jaccard 相似度。
 * 与 conversation-store.jaccardSimilarity 算法一致（中英文兼容）。
 */
function jaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2))
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0
  let intersection = 0
  for (const g of bigramsA) if (bigramsB.has(g)) intersection++
  const union = bigramsA.size + bigramsB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 注入历史持久化存储：log / listRecent / findSimilar / clear
 */
export class InjectionHistoryStore {
  /** 记录一次注入。超出 MAX_RECORDS 时淘汰最旧记录。 */
  log(record: Omit<InjectionRecord, 'id' | 'createdAt'>): InjectionRecord {
    const records = store.get('records') as InjectionRecord[]
    const now = Date.now()
    const full: InjectionRecord = {
      ...record,
      id: randomUUID(),
      createdAt: now,
    }
    records.push(full)
    // 超出上限时按时间升序淘汰最旧的若干条
    if (records.length > MAX_RECORDS) {
      records.sort((a, b) => a.createdAt - b.createdAt)
      const overflow = records.length - MAX_RECORDS
      records.splice(0, overflow)
    }
    store.set('records', records)
    return full
  }

  /** 列出最近 N 条注入记录（按时间倒序） */
  listRecent(limit = 50): InjectionRecord[] {
    const records = store.get('records')
    return [...records].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  /**
   * 在最近 limit 条记录中查找与 text 相似度 ≥ threshold 的记录。
   * 返回按相似度倒序排列的结果（最相似的在前）。
   */
  findSimilar(text: string, limit = 50, threshold = 0.85): SimilarInjectionResult[] {
    if (!text) return []
    const records = this.listRecent(limit)
    const results: SimilarInjectionResult[] = []
    for (const r of records) {
      const sim = jaccardSimilarity(text, r.composedText)
      if (sim >= threshold) {
        results.push({ ...r, similarity: sim })
      }
    }
    results.sort((a, b) => b.similarity - a.similarity)
    return results
  }

  /** 清空所有注入历史，返回删除的条数 */
  clear(): number {
    const count = store.get('records').length
    store.set('records', [])
    return count
  }
}

// 单例实例
export const injectionHistoryStore = new InjectionHistoryStore()
