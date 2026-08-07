// electron/store/nav-history-store.ts — 导航历史追踪器（SQLite 持久化 + 内存双写）
//
// 追踪每个 Profile 在主窗口中的导航历史。
// 当用户脱离标签为浏览器窗口时，历史可被传递给新窗口作为初始标签（clear 清除避免重复）。
//
// 双写策略：
//   - SQLite（nav-history.db）：持久化，重启后仍可见，承载 list/search/delete/clearAll 查询。
//   - 内存 Map<profileId, NavHistoryEntry[]>：write-through 缓存，加速 get(profileId) 读取；
//     首次访问某 profile 时从 SQLite 懒加载。
//
// 容量约束：全局上限 1000 条，超出时按 timestamp 淘汰最旧记录（内存 + SQLite 同步剔除）。

import { randomUUID } from 'crypto'
import type { NavHistoryEntry } from '../shared/types.js'
import { resolveSqlitePath, createSqliteDb, createSingletonHolder } from './store-paths.js'
import type Database from 'better-sqlite3'

/** 全局记录条数上限（超出按 timestamp 淘汰最旧） */
const MAX_ENTRIES = 1000

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nav_history (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nav_history_profile ON nav_history(profile_id);
    CREATE INDEX IF NOT EXISTS idx_nav_history_time ON nav_history(timestamp DESC);
  `)
}

const dbHolder = createSingletonHolder(
  () => createSqliteDb(resolveSqlitePath('nav-history.db'), initSchema),
  (db) => db.close(),
)

/** 行映射：snake_case → NavHistoryEntry */
function rowToEntry(row: Record<string, unknown>): NavHistoryEntry {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    url: row.url as string,
    title: row.title as string,
    timestamp: row.timestamp as number,
  }
}

class NavHistoryStore {
  private memory = new Map<string, NavHistoryEntry[]>()
  /** 已从 SQLite 加载到内存的 profileId 集合（避免重复懒加载） */
  private loaded = new Set<string>()

  private get db() {
    return dbHolder.get()
  }

  /** 懒加载某 profile 的全部记录到内存（仅首次访问时执行） */
  private ensureLoaded(profileId: string): void {
    if (this.loaded.has(profileId)) return
    const rows = this.db.prepare(
      `SELECT id, profile_id, url, title, timestamp FROM nav_history WHERE profile_id = ? ORDER BY timestamp ASC`,
    ).all(profileId) as Record<string, unknown>[]
    this.memory.set(profileId, rows.map(rowToEntry))
    this.loaded.add(profileId)
  }

  /**
   * 记录一次导航（去重：同 URL 连续不重复记录，仅更新 title）。
   * 内存 + SQLite 双写，超出上限时淘汰最旧记录。
   */
  record(profileId: string, entry: Omit<NavHistoryEntry, 'id' | 'profileId'>): void {
    this.ensureLoaded(profileId)
    const list = this.memory.get(profileId) ?? []
    const last = list[list.length - 1]
    if (last && last.url === entry.url) {
      // 同 URL 连续：仅更新 title（内存 + SQLite）
      if (entry.title && entry.title !== last.title) {
        last.title = entry.title
        this.db.prepare(`UPDATE nav_history SET title = ? WHERE id = ?`).run(entry.title, last.id)
      }
      console.log('[nav-history-store] 同 URL 连续，更新 title:', profileId, entry.url, entry.title)
      return
    }
    const full: NavHistoryEntry = {
      id: randomUUID(),
      profileId,
      url: entry.url,
      title: entry.title,
      timestamp: entry.timestamp,
    }
    list.push(full)
    this.memory.set(profileId, list)
    this.db.prepare(
      `INSERT INTO nav_history (id, profile_id, url, title, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run(full.id, full.profileId, full.url, full.title, full.timestamp)
    this.evictIfNeeded()
    console.log('[nav-history-store] 记录导航历史:', profileId, full.url, full.title)
  }

  /** 全局超限淘汰：删除最旧记录直至总数 ≤ MAX_ENTRIES（内存 + SQLite 同步） */
  private evictIfNeeded(): void {
    const count = this.db.prepare(`SELECT COUNT(*) as c FROM nav_history`).get() as { c: number }
    if (count.c <= MAX_ENTRIES) return
    const overflow = count.c - MAX_ENTRIES
    const victims = this.db.prepare(
      `SELECT id, profile_id FROM nav_history ORDER BY timestamp ASC LIMIT ?`,
    ).all(overflow) as Array<{ id: string; profile_id: string }>
    if (victims.length === 0) return
    const ids = victims.map((v) => v.id)
    this.db.prepare(`DELETE FROM nav_history WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    // 同步剔除内存
    for (const v of victims) {
      const arr = this.memory.get(v.profile_id)
      if (arr) {
        this.memory.set(
          v.profile_id,
          arr.filter((e) => e.id !== v.id),
        )
      }
    }
  }

  /** 获取某 Profile 的全部导航历史（按时间升序，内存缓存） */
  get(profileId: string): NavHistoryEntry[] {
    this.ensureLoaded(profileId)
    return this.memory.get(profileId) ?? []
  }

  /** 分页查询（按时间倒序；profileId 省略时跨 Profile 聚合） */
  list(profileId: string | undefined, page: number, pageSize: number): NavHistoryEntry[] {
    const offset = Math.max(0, (page - 1) * pageSize)
    const rows = profileId
      ? (this.db.prepare(
          `SELECT id, profile_id, url, title, timestamp FROM nav_history
           WHERE profile_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        ).all(profileId, pageSize, offset) as Record<string, unknown>[])
      : (this.db.prepare(
          `SELECT id, profile_id, url, title, timestamp FROM nav_history
           ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        ).all(pageSize, offset) as Record<string, unknown>[])
    return rows.map(rowToEntry)
  }

  /** 关键词搜索（URL / title 模糊匹配，按时间倒序；profileId 省略时跨 Profile 聚合） */
  search(profileId: string | undefined, keyword: string): NavHistoryEntry[] {
    const like = `%${keyword}%`
    const rows = profileId
      ? (this.db.prepare(
          `SELECT id, profile_id, url, title, timestamp FROM nav_history
           WHERE profile_id = ? AND (url LIKE ? OR title LIKE ?)
           ORDER BY timestamp DESC LIMIT 200`,
        ).all(profileId, like, like) as Record<string, unknown>[])
      : (this.db.prepare(
          `SELECT id, profile_id, url, title, timestamp FROM nav_history
           WHERE url LIKE ? OR title LIKE ?
           ORDER BY timestamp DESC LIMIT 200`,
        ).all(like, like) as Record<string, unknown>[])
    return rows.map(rowToEntry)
  }

  /** 删除单条记录（内存 + SQLite） */
  delete(id: string): void {
    const row = this.db.prepare(`SELECT profile_id FROM nav_history WHERE id = ?`).get(id) as
      | { profile_id: string }
      | undefined
    this.db.prepare(`DELETE FROM nav_history WHERE id = ?`).run(id)
    if (row) {
      const arr = this.memory.get(row.profile_id)
      if (arr) {
        this.memory.set(
          row.profile_id,
          arr.filter((e) => e.id !== id),
        )
      }
    }
  }

  /** 清除某 Profile 的历史（脱离后清除，避免重复；内存 + SQLite） */
  clear(profileId: string): void {
    this.db.prepare(`DELETE FROM nav_history WHERE profile_id = ?`).run(profileId)
    this.memory.delete(profileId)
    this.loaded.add(profileId) // 标记已加载（空）
  }

  /** 清空全部历史（可选按 profileId 过滤；内存 + SQLite） */
  clearAll(profileId?: string): void {
    if (profileId) {
      this.clear(profileId)
      return
    }
    this.db.prepare(`DELETE FROM nav_history`).run()
    this.memory.clear()
    this.loaded.clear()
  }
}

export const navHistoryStore = new NavHistoryStore()

/** 关闭数据库连接（应用退出时调用） */
export function closeNavHistoryStore(): void {
  dbHolder.close()
}
