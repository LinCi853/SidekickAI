// electron/store/browser-download-store.ts — 浏览器下载记录 SQLite 持久化
//
// 浏览器窗口下载管理：记录下载进度、完成状态、文件路径。
// 独立 SQLite 数据库（browser-downloads.db）。

import type { BrowserDownloadRecord } from '../shared/types.js'
import { resolveSqlitePath, createSqliteDb, createSingletonHolder } from './store-paths.js'
import type Database from 'better-sqlite3'

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_downloads (
      id TEXT PRIMARY KEY,
      window_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL,
      save_path TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'progressing',
      total_bytes INTEGER DEFAULT 0,
      received_bytes INTEGER DEFAULT 0,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      mime_type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_downloads_window ON browser_downloads(window_id);
    CREATE INDEX IF NOT EXISTS idx_browser_downloads_time ON browser_downloads(start_time DESC);
  `)
}

const dbHolder = createSingletonHolder(
  () => createSqliteDb(resolveSqlitePath('browser-downloads.db'), initSchema),
  (db) => db.close(),
)

class BrowserDownloadStore {
  private get db() {
    return dbHolder.get()
  }

  /** 添加一条下载记录 */
  add(record: BrowserDownloadRecord): void {
    this.db.prepare(
      `INSERT INTO browser_downloads (id, window_id, profile_id, url, filename, save_path, state, total_bytes, received_bytes, start_time, end_time, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.windowId, record.profileId, record.url, record.filename,
      record.savePath, record.state, record.totalBytes, record.receivedBytes,
      record.startTime, record.endTime ?? null, record.mimeType ?? null,
    )
  }

  /** 更新下载记录 */
  update(id: string, patch: Partial<BrowserDownloadRecord>): void {
    const existing = this.get(id)
    if (!existing) return
    const merged = { ...existing, ...patch }
    this.db.prepare(
      `UPDATE browser_downloads SET state = ?, total_bytes = ?, received_bytes = ?, end_time = ?, save_path = ? WHERE id = ?`,
    ).run(merged.state, merged.totalBytes, merged.receivedBytes, merged.endTime ?? null, merged.savePath, id)
  }

  /** 获取单条下载记录 */
  get(id: string): BrowserDownloadRecord | null {
    const row = this.db.prepare(
      `SELECT id, window_id as windowId, profile_id as profileId, url, filename, save_path as savePath, state, total_bytes as totalBytes, received_bytes as receivedBytes, start_time as startTime, end_time as endTime, mime_type as mimeType FROM browser_downloads WHERE id = ?`,
    ).get(id) as BrowserDownloadRecord | undefined
    return row ?? null
  }

  /** 列出下载记录（可选按 windowId 过滤，按时间倒序） */
  list(windowId?: string, limit = 50): BrowserDownloadRecord[] {
    let sql = `SELECT id, window_id as windowId, profile_id as profileId, url, filename, save_path as savePath, state, total_bytes as totalBytes, received_bytes as receivedBytes, start_time as startTime, end_time as endTime, mime_type as mimeType FROM browser_downloads`
    const params: (string | number)[] = []
    if (windowId) {
      sql += ` WHERE window_id = ?`
      params.push(windowId)
    }
    sql += ` ORDER BY start_time DESC LIMIT ?`
    params.push(limit)
    return this.db.prepare(sql).all(...params) as BrowserDownloadRecord[]
  }

  /** 删除下载记录 */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM browser_downloads WHERE id = ?`).run(id)
  }

  /** 清空全部下载记录（可选按 windowId 过滤） */
  clearAll(windowId?: string): void {
    if (windowId) {
      this.db.prepare(`DELETE FROM browser_downloads WHERE window_id = ?`).run(windowId)
    } else {
      this.db.prepare(`DELETE FROM browser_downloads`).run()
    }
  }
}

export const browserDownloadStore = new BrowserDownloadStore()
export function closeBrowserDownloadStore(): void {
  dbHolder.close()
}
