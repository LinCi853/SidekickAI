// electron/store/accumulated-links-store.ts — AI 应用内新窗口链接累积存储
//
// E1：AI 应用（主窗口模式）内点击需要新窗口打开的链接时，主进程拦截并累积到后台。
// 当用户将 AI 应用独立为浏览器窗口时，BrowserView 初始化后通过 consume() 取出全部
// 累积链接并转为标签页。
//
// 双模式（由 AppSettings.browserTabPersistence 决定）：
//   - memory（默认）：累积在内存 Map，主窗口关闭时清空，重启后不恢复
//   - persistent：累积持久化到 SQLite（accumulated-links.db），重启后仍可恢复
//
// 注意：仅在主窗口 AI 应用内累积；浏览器窗口内的新窗口链接不累积（由 helpers.ts
// 的 attachWebviewPopupInterceptor 根据 window URL 是否含 mode=browser 区分）。

import Database from 'better-sqlite3'
import { resolveSqlitePath } from './store-paths.js'

/** 累积链接条目 */
export interface AccumulatedLink {
  id: string
  profileId: string
  url: string
  title: string
  timestamp: number
}

/**
 * 累积链接存储：内存模式 / 持久化模式二选一（按调用方传入的 persistent 参数）。
 * 主窗口默认使用内存模式，仅在用户开启持久化设置后切换到 SQLite。
 */
class AccumulatedLinksStore {
  /** 内存模式：profileId → links 数组（按 timestamp 升序） */
  private memory = new Map<string, AccumulatedLink[]>()
  /** 持久化模式 SQLite 连接（懒初始化，仅 persistent=true 时创建） */
  private db: Database.Database | null = null

  /** 懒初始化 SQLite 连接（仅持久化模式调用） */
  private initDb(): void {
    if (this.db) return
    const dbPath = resolveSqlitePath('accumulated-links.db')
    console.log('[accumulated-links] 持久化数据库路径:', dbPath)
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accumulated_links (
        id TEXT PRIMARY KEY,
        profileId TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_accumulated_links_profile ON accumulated_links(profileId, timestamp)`,
    )
  }

  /**
   * 添加一条累积链接。
   * @param profileId  AI 应用 Profile id
   * @param url        被拦截的新窗口链接
   * @param title      链接标题（拦截时通常无页面 title，使用 URL 或空串）
   * @param persistent true=持久化到 SQLite / false=仅内存
   */
  add(profileId: string, url: string, title: string, persistent: boolean): void {
    const link: AccumulatedLink = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      profileId,
      url,
      title,
      timestamp: Date.now(),
    }
    if (persistent) {
      this.initDb()
      this.db!
        .prepare(
          'INSERT INTO accumulated_links (id, profileId, url, title, timestamp) VALUES (?, ?, ?, ?, ?)',
        )
        .run(link.id, link.profileId, link.url, link.title, link.timestamp)
    } else {
      const arr = this.memory.get(profileId) ?? []
      arr.push(link)
      this.memory.set(profileId, arr)
    }
  }

  /** 列出指定 Profile 的全部累积链接（按 timestamp 升序） */
  list(profileId: string, persistent: boolean): AccumulatedLink[] {
    if (persistent) {
      this.initDb()
      return this.db!
        .prepare(
          'SELECT id, profileId, url, title, timestamp FROM accumulated_links WHERE profileId = ? ORDER BY timestamp ASC',
        )
        .all(profileId) as AccumulatedLink[]
    }
    return this.memory.get(profileId) ?? []
  }

  /** 取出并清空指定 Profile 的全部累积链接（原子语义：list + clear） */
  consume(profileId: string, persistent: boolean): AccumulatedLink[] {
    const links = this.list(profileId, persistent)
    this.clear(profileId, persistent)
    return links
  }

  /** 清空指定 Profile 的全部累积链接 */
  clear(profileId: string, persistent: boolean): void {
    if (persistent) {
      this.initDb()
      this.db!.prepare('DELETE FROM accumulated_links WHERE profileId = ?').run(profileId)
    } else {
      this.memory.delete(profileId)
    }
  }
}

/** 单例导出 */
export const accumulatedLinksStore = new AccumulatedLinksStore()
