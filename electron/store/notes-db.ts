// electron/store/notes-db.ts — 灵感笔记 SQLite 持久化 + FTS5 全文搜索 + IPC 注册
//
// 迁移自 electron-store（notes.json 全量重写）。使用 better-sqlite3（WAL）。
// 支持 TipTap 富文本：content_json 存 ProseMirror JSON，content_text 存纯文本（用于搜索与标题推导）。
// 支持 FTS5 全文搜索、置顶、标签分类。
//
// 数据库路径：
//   - dev：项目内 .app-data/notes.db
//   - 便携：exe 同级 data/notes.db
//   - 安装：userData/notes.db
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { registerSafeIpcHandler, registerSyncIpcHandler } from '../shared/ipc-utils.js'
import {
  resolveSqlitePath,
  createSqliteDb,
  createSingletonHolder,
  MetaTable,
} from './store-paths.js'
import type { Note, NoteSaveInput } from '../shared/notes.types.js'

export type { Note, NoteSaveInput }

/** 笔记列表筛选条件 */
export interface NoteListFilter {
  keyword?: string
  tag?: string
  pinnedOnly?: boolean
}

/** 从纯文本推导标题：首个非空行截断 30 字 */
function deriveTitle(contentText: string): string {
  const firstLine = contentText.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return firstLine ? firstLine.slice(0, 30) : '未命名笔记'
}

export class NotesDb {
  private db: Database.Database
  private meta: MetaTable<string>

  constructor(dbPath?: string) {
    const finalPath = dbPath ?? resolveSqlitePath('notes.db')
    console.log('[notes-db] 数据库路径:', finalPath)
    this.db = createSqliteDb(finalPath, (db) => this.initSchema(db))
    this.meta = new MetaTable<string>(this.db, 'notes_meta')
  }

  private initSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT,
        content_text TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        window_title TEXT,
        ai_platform TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content_text, content='notes', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content_text) VALUES (new.rowid, new.title, new.content_text);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content_text) VALUES('delete', old.rowid, old.title, old.content_text);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content_text) VALUES('delete', old.rowid, old.title, old.content_text);
        INSERT INTO notes_fts(rowid, title, content_text) VALUES (new.rowid, new.title, new.content_text);
      END;
    `)
  }

  private rowToNote(row: Record<string, unknown>): Note {
    return {
      id: row.id as string,
      title: (row.title as string) || null,
      content: row.content_text as string,
      contentJson: row.content_json as string,
      pinned: Boolean(row.pinned),
      tags: JSON.parse((row.tags as string) || '[]'),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      windowTitle: (row.window_title as string) || undefined,
      aiPlatform: (row.ai_platform as string) || undefined,
    }
  }

  /** 列出笔记（按 pinned DESC, updated_at DESC），支持搜索/标签/置顶筛选 */
  listNotes(filter?: NoteListFilter): Note[] {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter?.pinnedOnly) conditions.push('pinned = 1')
    if (filter?.tag) {
      // tags 是 JSON 数组，用 LIKE 近似匹配（标签场景可接受）
      conditions.push("tags LIKE ?")
      params.push(`%"${filter.tag}"%`)
    }
    if (filter?.keyword && filter.keyword.trim()) {
      // 走 FTS5 全文搜索
      const ftsRows = this.db.prepare(
        `SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?`,
      ).all(filter.keyword.trim()) as Array<{ rowid: number }>
      if (ftsRows.length === 0) return []
      const rowids = ftsRows.map((r) => r.rowid)
      conditions.push(`rowid IN (${rowids.map(() => '?').join(',')})`)
      params.push(...rowids)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT * FROM notes ${where} ORDER BY pinned DESC, updated_at DESC`,
    ).all(...params) as Record<string, unknown>[]
    return rows.map((r) => this.rowToNote(r))
  }

  /** 获取单条笔记 */
  getNote(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToNote(row) : null
  }

  /** 新增或更新笔记（upsert）。无 id 时新增；有 id 时更新。 */
  saveNote(input: NoteSaveInput): Note {
    const now = Date.now()
    if (input.id) {
      const existing = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(input.id) as Record<string, unknown> | undefined
      if (existing) {
        const contentText = input.content ?? (existing.content_text as string)
        const title = input.title ?? deriveTitle(contentText)
        const contentJson = input.contentJson ?? (existing.content_json as string)
        const pinned = input.pinned ?? Boolean(existing.pinned)
        const tags = input.tags ?? JSON.parse((existing.tags as string) || '[]')
        this.db.prepare(
          `UPDATE notes SET title = ?, content_text = ?, content_json = ?, pinned = ?, tags = ?, updated_at = ?
           WHERE id = ?`,
        ).run(title, contentText, contentJson, pinned ? 1 : 0, JSON.stringify(tags), now, input.id)
        return this.getNote(input.id)!
      }
    }
    // 新增
    const id = input.id || randomUUID()
    const contentText = input.content ?? ''
    const title = input.title ?? deriveTitle(contentText)
    const contentJson = input.contentJson ?? ''
    const pinned = input.pinned ?? false
    const tags = input.tags ?? []
    this.db.prepare(
      `INSERT INTO notes (id, title, content_text, content_json, pinned, tags, created_at, updated_at, window_title, ai_platform)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, contentText, contentJson, pinned ? 1 : 0, JSON.stringify(tags), now, now, input.windowTitle ?? null, input.aiPlatform ?? null)
    return this.getNote(id)!
  }

  /** 删除笔记 */
  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    if (this.getActiveNoteId() === id) {
      this.meta.delete('active_note_id')
    }
  }

  /** 设置置顶 */
  setNotePinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?').run(pinned ? 1 : 0, Date.now(), id)
  }

  /** 设置标签 */
  setNoteTags(id: string, tags: string[]): void {
    this.db.prepare('UPDATE notes SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(tags), Date.now(), id)
  }

  /** 列出全部已用标签（去重） */
  listAllTags(): string[] {
    const rows = this.db.prepare('SELECT tags FROM notes').all() as Array<{ tags: string }>
    const set = new Set<string>()
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.tags || '[]') as string[]
        arr.forEach((t) => set.add(t))
      } catch { /* ignore */ }
    }
    return Array.from(set).sort()
  }

  /** 获取激活笔记 id */
  getActiveNoteId(): string | null {
    return this.meta.get('active_note_id')
  }

  /** 设置激活笔记 id */
  setActiveNoteId(id: string | null): void {
    if (id === null) {
      this.meta.delete('active_note_id')
      return
    }
    this.meta.set('active_note_id', id)
  }

  close(): void {
    this.db.close()
  }
}

/** 单例 */
const notesDbHolder = createSingletonHolder<NotesDb>(
  () => new NotesDb(),
  (db) => db.close(),
)
export function getNotesDb(): NotesDb {
  return notesDbHolder.get()
}
export function closeNotesDb(): void {
  notesDbHolder.close()
}

/**
 * 注册笔记 IPC handler（app.whenReady 后调用）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerNotesIPC(scope?: EffectScope): void {
  const ipc = IPC_CHANNELS
  const db = getNotesDb()

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(ipc.NOTES_LIST, (_e: unknown, filter?: NoteListFilter) => {
    try {
      return db.listNotes(filter)
    } catch (err) {
      console.error('[notes-db] list 失败:', err)
      return []
    }
  })
  handle(ipc.NOTES_SEARCH, (_e: unknown, keyword: string) => {
    try {
      return db.listNotes({ keyword })
    } catch (err) {
      console.error('[notes-db] search 失败:', err)
      return []
    }
  })
  handle(ipc.NOTES_SAVE, (_e: unknown, input: NoteSaveInput) => {
    try {
      return db.saveNote(input)
    } catch (err) {
      console.error('[notes-db] save 失败:', err)
      throw err
    }
  })
  registerSafeIpcHandler(
    ipc.NOTES_DELETE,
    (_e, id: string) => {
      db.deleteNote(id)
      return { ok: true }
    },
    'notes-db deleteNote',
    scope,
  )
  handle(ipc.NOTES_GET_ACTIVE, () => {
    try {
      const id = db.getActiveNoteId()
      return id ? db.getNote(id) : null
    } catch (err) {
      console.error('[notes-db] getActive 失败:', err)
      return null
    }
  })
  registerSafeIpcHandler(
    ipc.NOTES_SET_ACTIVE,
    (_e, id: string | null) => {
      db.setActiveNoteId(id)
      return { ok: true }
    },
    'notes-db setActive',
    scope,
  )
  registerSafeIpcHandler(
    ipc.NOTES_SET_PINNED,
    (_e, id: string, pinned: boolean) => {
      db.setNotePinned(id, pinned)
      return { ok: true }
    },
    'notes-db setPinned',
    scope,
  )
  registerSafeIpcHandler(
    ipc.NOTES_SET_TAGS,
    (_e, id: string, tags: string[]) => {
      db.setNoteTags(id, tags)
      return { ok: true }
    },
    'notes-db setTags',
    scope,
  )
  handle(ipc.NOTES_LIST_TAGS, () => {
    try {
      return db.listAllTags()
    } catch (err) {
      console.error('[notes-db] listTags 失败:', err)
      return []
    }
  })
  // 同步保存（beforeunload 兜底，sendSync 确保窗口关闭前完成写入）
  registerSyncIpcHandler(
    ipc.NOTES_SAVE_SYNC,
    (_e, input: NoteSaveInput) => {
      db.saveNote(input)
    },
    'notes-db saveSync',
    scope,
  )
}
