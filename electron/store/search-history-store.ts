// electron/store/search-history-store.ts — 搜索历史 SQLite 持久化
//
// 浏览器窗口地址栏搜索记录 + 自动补全。
// 独立 SQLite 数据库（search-history.db）。

import type { SearchHistoryEntry } from '../shared/types.js'
import { resolveSqlitePath, createSqliteDb, createSingletonHolder } from './store-paths.js'
import type Database from 'better-sqlite3'

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      query TEXT NOT NULL,
      url TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_history_profile ON search_history(profile_id);
    CREATE INDEX IF NOT EXISTS idx_search_history_timestamp ON search_history(timestamp DESC);
  `)
}

const dbHolder = createSingletonHolder(
  () => createSqliteDb(resolveSqlitePath('search-history.db'), initSchema),
  (db) => db.close(),
)

class SearchHistoryStore {
  private get db() {
    return dbHolder.get()
  }

  /** 记录一条搜索历史 */
  add(entry: { profileId: string; query: string; url: string }): void {
    this.db.prepare(
      `INSERT INTO search_history (id, profile_id, query, url, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), entry.profileId, entry.query, entry.url, Date.now())
  }

  /** 查询搜索历史（按 profileId，可选关键词过滤，按时间倒序） */
  list(profileId: string, keyword?: string, limit = 20): SearchHistoryEntry[] {
    let sql = `SELECT id, profile_id as profileId, query, url, timestamp FROM search_history WHERE profile_id = ?`
    const params: (string | number)[] = [profileId]
    if (keyword) {
      sql += ` AND query LIKE ?`
      params.push(`%${keyword}%`)
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`
    params.push(limit)
    return this.db.prepare(sql).all(...params) as SearchHistoryEntry[]
  }

  /** 清除某 Profile 的搜索历史 */
  clear(profileId?: string): void {
    if (profileId) {
      this.db.prepare(`DELETE FROM search_history WHERE profile_id = ?`).run(profileId)
    } else {
      this.db.prepare(`DELETE FROM search_history`).run()
    }
  }
}

export const searchHistoryStore = new SearchHistoryStore()
export function closeSearchHistoryStore(): void {
  dbHolder.close()
}
