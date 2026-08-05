// electron/store/bookmark-store.ts — 浏览器书签 SQLite 持久化（v0.0.9）
//
// 全局书签（跨所有 AI 应用汇聚），记录来源应用信息（profileId + profileName
// 快照 + aiPlatformId + platformName 快照）。独立 SQLite 数据库（bookmarks.db）。
// 仿 search-history-store.ts 模式。

import type { Bookmark, BookmarkInput, BookmarkFilter, BookmarkPatch } from '../shared/bookmark.types.js'
import { resolveSqlitePath, createSqliteDb, createSingletonHolder } from './store-paths.js'
import type Database from 'better-sqlite3'

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      favicon TEXT,
      profile_id TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      ai_platform_id TEXT,
      platform_name TEXT,
      in_bookmark_bar INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_bar ON bookmarks(in_bookmark_bar, sort_order);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_profile ON bookmarks(profile_id);
  `)
}

const dbHolder = createSingletonHolder(
  () => createSqliteDb(resolveSqlitePath('bookmarks.db'), initSchema),
  (db) => db.close(),
)

/** 数据库行结构（snake_case） */
interface BookmarkRow {
  id: string
  title: string
  url: string
  favicon: string | null
  profile_id: string
  profile_name: string
  ai_platform_id: string | null
  platform_name: string | null
  in_bookmark_bar: number
  sort_order: number
  created_at: number
  updated_at: number
}

/** 行 → Bookmark 对象（camelCase + 布尔转换） */
function rowToBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    favicon: row.favicon ?? undefined,
    profileId: row.profile_id,
    profileName: row.profile_name,
    aiPlatformId: row.ai_platform_id ?? undefined,
    platformName: row.platform_name ?? undefined,
    inBookmarkBar: row.in_bookmark_bar === 1,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

class BookmarkStore {
  private get db() {
    return dbHolder.get()
  }

  /** 查询书签列表（可选过滤） */
  list(filter?: BookmarkFilter): Bookmark[] {
    let sql = `SELECT * FROM bookmarks WHERE 1=1`
    const params: (string | number)[] = []
    if (filter?.profileId) {
      sql += ` AND profile_id = ?`
      params.push(filter.profileId)
    }
    if (filter?.barOnly) {
      sql += ` AND in_bookmark_bar = 1`
    }
    sql += ` ORDER BY sort_order ASC, created_at DESC`
    const rows = this.db.prepare(sql).all(...params) as BookmarkRow[]
    return rows.map(rowToBookmark)
  }

  /** 新增书签；返回完整 Bookmark */
  add(input: BookmarkInput): Bookmark {
    const now = Date.now()
    const id = crypto.randomUUID()
    // 新书签默认排到书签栏末尾
    const maxOrderRow = this.db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) as max_order FROM bookmarks WHERE in_bookmark_bar = 1`)
      .get() as { max_order: number } | undefined
    const order = (maxOrderRow?.max_order ?? -1) + 1
    this.db
      .prepare(
        `INSERT INTO bookmarks
          (id, title, url, favicon, profile_id, profile_name, ai_platform_id, platform_name, in_bookmark_bar, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.url,
        input.favicon ?? null,
        input.profileId,
        input.profileName,
        input.aiPlatformId ?? null,
        input.platformName ?? null,
        input.inBookmarkBar === false ? 0 : 1,
        order,
        now,
        now,
      )
    return this.get(id)!
  }

  /** 按 id 查询；不存在返回 undefined */
  get(id: string): Bookmark | undefined {
    const row = this.db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id) as BookmarkRow | undefined
    return row ? rowToBookmark(row) : undefined
  }

  /** 更新书签（部分字段）；返回更新后的对象，不存在返回 undefined */
  update(id: string, patch: BookmarkPatch): Bookmark | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE bookmarks SET
          title = COALESCE(?, title),
          url = COALESCE(?, url),
          favicon = COALESCE(?, favicon),
          in_bookmark_bar = COALESCE(?, in_bookmark_bar),
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.title ?? null,
        patch.url ?? null,
        patch.favicon ?? null,
        patch.inBookmarkBar === undefined ? null : patch.inBookmarkBar ? 1 : 0,
        now,
        id,
      )
    return this.get(id)
  }

  /** 删除书签 */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM bookmarks WHERE id = ?`).run(id)
  }

  /** 重排序书签栏（按 ids 顺序依次赋值 sort_order） */
  reorder(ids: string[]): void {
    const tx = this.db.transaction((idsArr: string[]) => {
      idsArr.forEach((id, idx) => {
        this.db.prepare(`UPDATE bookmarks SET sort_order = ? WHERE id = ?`).run(idx, id)
      })
    })
    tx(ids)
  }

  /** 切换书签是否显示到书签栏 */
  toggleBar(id: string, visible: boolean): void {
    this.db
      .prepare(`UPDATE bookmarks SET in_bookmark_bar = ?, updated_at = ? WHERE id = ?`)
      .run(visible ? 1 : 0, Date.now(), id)
  }

  /** 按 URL 查询书签（用于星标按钮判断是否已收藏） */
  findByUrl(url: string): Bookmark | undefined {
    const row = this.db.prepare(`SELECT * FROM bookmarks WHERE url = ? LIMIT 1`).get(url) as BookmarkRow | undefined
    return row ? rowToBookmark(row) : undefined
  }
}

export const bookmarkStore = new BookmarkStore()
export function closeBookmarkStore(): void {
  dbHolder.close()
}
