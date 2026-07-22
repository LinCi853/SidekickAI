// electron/store/window-trace-store.ts — 窗口操作痕迹 SQLite 持久化
//
// 从 chat-store.ts 拆分出来的职责子模块，仅负责 window_traces 表的 CRUD。
// 表结构（CREATE TABLE window_traces ...）仍由 ChatStore.initSchema 统一维护，
// 因为建表顺序与外键/索引相关性较强，集中管理风险更低。
//
// ChatStore 通过 facade 委托模式调用本类，调用点（getChatStore().logWindowTrace() 等）
// 完全无需修改。

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { WindowTrace, WindowTraceAction } from '../shared/types.js'

/** 窗口痕迹查询条数上限 */
const MAX_TRACE_LIMIT = 2000

interface WindowTraceRow {
  id: string
  window_id: string
  action: string
  detail: string | null
  timestamp: number
}

/** 将数据库行映射为 WindowTrace 对象 */
function rowToWindowTrace(r: WindowTraceRow): WindowTrace {
  return {
    id: r.id,
    windowId: r.window_id,
    action: r.action as WindowTraceAction,
    detail: r.detail ?? undefined,
    timestamp: r.timestamp,
  }
}

/**
 * 窗口操作痕迹 SQLite 持久化存储
 *
 * 所有方法同步执行（better-sqlite3 特性），在主进程内调用。
 * 由 ChatStore 持有实例并通过 facade 委托暴露。
 */
export class WindowTraceStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  logWindowTrace(windowId: string, action: WindowTraceAction, detail?: unknown): void {
    const trace: WindowTrace = {
      id: randomUUID(),
      windowId,
      action,
      detail: detail != null ? JSON.stringify(detail) : undefined,
      timestamp: Date.now(),
    }
    this.db
      .prepare(
        'INSERT INTO window_traces (id, window_id, action, detail, timestamp) VALUES (?, ?, ?, ?, ?)',
      )
      .run(trace.id, trace.windowId, trace.action, trace.detail ?? null, trace.timestamp)
  }

  listWindowTraces(windowId?: string, limit = 200): WindowTrace[] {
    const safeLimit = Math.max(1, Math.min(MAX_TRACE_LIMIT, limit))
    if (windowId) {
      const rows = this.db
        .prepare(
          'SELECT * FROM window_traces WHERE window_id = ? ORDER BY timestamp DESC LIMIT ?',
        )
        .all(windowId, safeLimit) as WindowTraceRow[]
      return rows.map(rowToWindowTrace)
    }
    const rows = this.db
      .prepare('SELECT * FROM window_traces ORDER BY timestamp DESC LIMIT ?')
      .all(safeLimit) as WindowTraceRow[]
    return rows.map(rowToWindowTrace)
  }

  /** 清空窗口操作痕迹（可选按 windowId 过滤），返回删除的行数 */
  clearWindowTraces(windowId?: string): number {
    if (windowId) {
      const result = this.db
        .prepare('DELETE FROM window_traces WHERE window_id = ?')
        .run(windowId)
      return result.changes
    }
    const result = this.db.prepare('DELETE FROM window_traces').run()
    return result.changes
  }
}
