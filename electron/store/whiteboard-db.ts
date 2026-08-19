// electron/store/whiteboard-db.ts — 白板多白板 SQLite 持久化 + IPC 注册
//
// 迁移自 electron-store（whiteboard.json 全量重写）。使用 better-sqlite3（WAL）。
// 支持多白板：每个白板一条 whiteboards 记录 + 一条 whiteboard_snapshots（Excalidraw scene JSON）。
//
// 数据库路径：
//   - dev：项目内 .app-data/whiteboard.db
//   - 便携：exe 同级 data/whiteboard.db
//   - 安装：userData/whiteboard.db
//
// better-sqlite3 同步 API，所有方法阻塞调用，适合单次写入与查询。
// 所有 CRUD 在主进程执行，通过 IPC 暴露给渲染进程。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import type { EffectScope } from '../modules/effect-scope.js'
import { randomUUID } from 'crypto'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { registerSafeIpcHandler, registerSyncIpcHandler } from '../shared/ipc-utils.js'
import type { WhiteboardMeta } from '../shared/whiteboard.types.js'
import {
  resolveSqlitePath,
  createSqliteDb,
  createSingletonHolder,
  MetaTable,
} from './store-paths.js'

export type { WhiteboardMeta }

/** 白板完整数据（含 snapshot） */
export interface WhiteboardWithSnapshot extends WhiteboardMeta {
  /** Excalidraw scene 序列化 JSON 字符串；新白板为 null（用空场景初始化） */
  snapshot: string | null
}

export class WhiteboardDb {
  private db: Database.Database
  private meta: MetaTable<string>

  constructor(dbPath?: string) {
    const finalPath = dbPath ?? resolveSqlitePath('whiteboard.db')
    console.log('[whiteboard-db] 数据库路径:', finalPath)
    this.db = createSqliteDb(finalPath, (db) => this.initSchema(db))
    this.meta = new MetaTable<string>(this.db, 'whiteboard_meta')
  }

  private initSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whiteboards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '未命名白板',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_wb_updated ON whiteboards(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wb_sort ON whiteboards(sort_order);

      CREATE TABLE IF NOT EXISTS whiteboard_snapshots (
        whiteboard_id TEXT PRIMARY KEY REFERENCES whiteboards(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  /** 列出全部白板（按 sort_order ASC, updated_at DESC） */
  listWhiteboards(): WhiteboardMeta[] {
    const rows = this.db.prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, sort_order AS sortOrder
       FROM whiteboards ORDER BY sort_order ASC, updated_at DESC`,
    ).all() as WhiteboardMeta[]
    return rows
  }

  /** 新建白板，返回元信息（snapshot 为 null，渲染层用空场景初始化） */
  createWhiteboard(title?: string): WhiteboardMeta {
    const now = Date.now()
    const id = randomUUID()
    const maxSort = (this.db.prepare('SELECT MAX(sort_order) AS m FROM whiteboards').get() as { m: number | null }).m ?? 0
    this.db.prepare(
      'INSERT INTO whiteboards (id, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?)',
    ).run(id, title || '未命名白板', now, now, maxSort + 1)
    return { id, title: title || '未命名白板', createdAt: now, updatedAt: now, sortOrder: maxSort + 1 }
  }

  /** 重命名白板 */
  renameWhiteboard(id: string, title: string): void {
    this.db.prepare('UPDATE whiteboards SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
  }

  /** 删除白板（级联删 snapshot） */
  deleteWhiteboard(id: string): void {
    this.db.prepare('DELETE FROM whiteboards WHERE id = ?').run(id)
    // active 指向被删白板时清空
    if (this.getActiveWhiteboardId() === id) {
      this.meta.delete('active_whiteboard_id')
    }
  }

  /** 获取激活白板 id */
  getActiveWhiteboardId(): string | null {
    return this.meta.get('active_whiteboard_id')
  }

  /** 设置激活白板 id */
  setActiveWhiteboardId(id: string | null): void {
    if (id === null) {
      this.meta.delete('active_whiteboard_id')
      return
    }
    this.meta.set('active_whiteboard_id', id)
  }

  /** 加载白板 snapshot（无则返回 null） */
  loadSnapshot(id: string): string | null {
    const row = this.db.prepare('SELECT snapshot FROM whiteboard_snapshots WHERE whiteboard_id = ?').get(id) as { snapshot: string } | undefined
    return row?.snapshot ?? null
  }

  /** 保存白板 snapshot（全量 upsert，单次写入） */
  saveSnapshot(id: string, snapshot: string): void {
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO whiteboard_snapshots (whiteboard_id, snapshot, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(whiteboard_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
    ).run(id, snapshot, now)
    this.db.prepare('UPDATE whiteboards SET updated_at = ? WHERE id = ?').run(now, id)
  }

  /** 重新排序白板（ids 按新顺序） */
  reorderWhiteboards(ids: string[]): void {
    const tx = this.db.transaction((orderedIds: string[]) => {
      orderedIds.forEach((id, idx) => {
        this.db.prepare('UPDATE whiteboards SET sort_order = ? WHERE id = ?').run(idx + 1, id)
      })
    })
    tx(ids)
  }

  close(): void {
    this.db.close()
  }
}

/** 单例 */
const whiteboardDbHolder = createSingletonHolder<WhiteboardDb>(
  () => new WhiteboardDb(),
  (db) => db.close(),
)
export function getWhiteboardDb(): WhiteboardDb {
  return whiteboardDbHolder.get()
}
export function closeWhiteboardDb(): void {
  whiteboardDbHolder.close()
}

/**
 * 注册白板 IPC handler（app.whenReady 后调用）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerWhiteboardIPC(scope?: EffectScope): void {
  const ipc = IPC_CHANNELS
  const db = getWhiteboardDb()

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(ipc.WHITEBOARD_LIST, () => {
    try {
      return db.listWhiteboards()
    } catch (err) {
      console.error('[whiteboard-db] list 失败:', err)
      return []
    }
  })
  handle(ipc.WHITEBOARD_CREATE, (_e: unknown, title?: string) => {
    try {
      return db.createWhiteboard(title)
    } catch (err) {
      console.error('[whiteboard-db] create 失败:', err)
      throw err
    }
  })
  registerSafeIpcHandler(
    ipc.WHITEBOARD_RENAME,
    (_e, id: string, title: string) => {
      db.renameWhiteboard(id, title)
      return { ok: true }
    },
    'whiteboard-db rename',
    scope,
  )
  registerSafeIpcHandler(
    ipc.WHITEBOARD_DELETE,
    (_e, id: string) => {
      db.deleteWhiteboard(id)
      return { ok: true }
    },
    'whiteboard-db delete',
    scope,
  )
  registerSafeIpcHandler(
    ipc.WHITEBOARD_REORDER,
    (_e, ids: string[]) => {
      db.reorderWhiteboards(ids)
      return { ok: true }
    },
    'whiteboard-db reorder',
    scope,
  )
  handle(ipc.WHITEBOARD_GET_ACTIVE, () => {
    try {
      return db.getActiveWhiteboardId()
    } catch (err) {
      console.error('[whiteboard-db] getActive 失败:', err)
      return null
    }
  })
  registerSafeIpcHandler(
    ipc.WHITEBOARD_SET_ACTIVE,
    (_e, id: string | null) => {
      db.setActiveWhiteboardId(id)
      return { ok: true }
    },
    'whiteboard-db setActive',
    scope,
  )
  handle(ipc.WHITEBOARD_GET_SNAPSHOT, (_e: unknown, id: string) => {
    try {
      return db.loadSnapshot(id)
    } catch (err) {
      console.error('[whiteboard-db] getSnapshot 失败:', err)
      return null
    }
  })
  registerSafeIpcHandler(
    ipc.WHITEBOARD_SAVE_SNAPSHOT,
    (_e, id: string, snapshot: string) => {
      db.saveSnapshot(id, snapshot)
      return { ok: true }
    },
    'whiteboard-db saveSnapshot',
    scope,
  )
  // 同步保存（beforeunload 兜底）
  registerSyncIpcHandler(
    ipc.WHITEBOARD_SAVE_SNAPSHOT_SYNC,
    (_e, id: string, snapshot: string) => {
      db.saveSnapshot(id, snapshot)
    },
    'whiteboard-db saveSnapshotSync',
    scope,
  )
}
