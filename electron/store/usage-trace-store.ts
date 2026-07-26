// electron/store/usage-trace-store.ts — 使用统计与操作日志 SQLite 持久化
//
// 从 chat-store.ts 拆分出来的职责子模块，负责 app_starts / click_logs 表的 CRUD。
// 表结构（CREATE TABLE ...）由 ChatStore.initSchema 在 v4 迁移中统一创建。
//
// 记录内容：
//   - app_starts：每次应用启动的时间戳、版本、便携模式标记、退出时间
//   - click_logs：带 data-name 属性的 UI 元素点击事件（元素名、窗口类型、时间戳）
//
// 隐私：完全本地存储，不上传任何数据。用户可在设置中关闭（usageTrackingEnabled=false）。
// 关闭后：主进程不再调用 logAppStart/logClick，但已存储的历史数据保留（用户可手动清除）。

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { isPortableMode } from './store-paths.js'

/** 应用启动记录 */
export interface AppStart {
  id: string
  startTime: number
  endTime: number | null
  version: string
  portable: boolean
}

/** 点击日志记录 */
export interface ClickLog {
  id: string
  timestamp: number
  elementName: string
  windowType: string | null
  detail: string | null
}

/** 频次统计结果 */
export interface FrequencyStats {
  /** 总点击次数 */
  totalClicks: number
  /** 热键相关点击次数（data-name 包含 'hotkey' 或 'shortcut'） */
  hotkeyCount: number
  /** API 对话相关点击次数（data-name 包含 'chat.send' 或 'chat.send-button'） */
  apiChatCount: number
  /** 按元素名分组的点击次数（Top 20） */
  topElements: Array<{ name: string; count: number }>
  /** 按窗口类型分组的点击次数 */
  byWindowType: Array<{ windowType: string; count: number }>
  /** 最近 N 条启动记录 */
  appStarts: AppStart[]
}

interface AppStartRow {
  id: string
  start_time: number
  end_time: number | null
  version: string
  portable: number
}

interface ClickLogRow {
  id: string
  timestamp: number
  element_name: string
  window_type: string | null
  detail: string | null
}

function rowToAppStart(r: AppStartRow): AppStart {
  return {
    id: r.id,
    startTime: r.start_time,
    endTime: r.end_time,
    version: r.version,
    portable: r.portable === 1,
  }
}

function rowToClickLog(r: ClickLogRow): ClickLog {
  return {
    id: r.id,
    timestamp: r.timestamp,
    elementName: r.element_name,
    windowType: r.window_type,
    detail: r.detail,
  }
}

/**
 * 使用统计与操作日志 SQLite 持久化存储
 *
 * 所有方法同步执行（better-sqlite3 特性），在主进程内调用。
 * 由 ChatStore 持有实例并通过 facade 委托暴露。
 */
export class UsageTraceStore {
  private db: Database.Database
  /** 当前启动会话 id（logAppStart 时生成，logAppEnd 时使用并清空） */
  private currentStartId: string | null = null

  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * 记录应用启动。
   * 生成新 id 并写入 app_starts 表，currentStartId 在 logAppEnd 时使用。
   */
  logAppStart(): string {
    const id = randomUUID()
    const startTime = Date.now()
    const version = app.getVersion()
    const portable = isPortableMode() ? 1 : 0
    this.db
      .prepare(
        'INSERT INTO app_starts (id, start_time, end_time, version, portable) VALUES (?, ?, NULL, ?, ?)',
      )
      .run(id, startTime, version, portable)
    this.currentStartId = id
    return id
  }

  /**
   * 记录应用退出（更新 currentStartId 对应记录的 end_time）。
   * 若无 currentStartId（未调用 logAppStart 或已调用过 logAppEnd），静默跳过。
   */
  logAppEnd(): void {
    if (!this.currentStartId) return
    try {
      this.db
        .prepare('UPDATE app_starts SET end_time = ? WHERE id = ?')
        .run(Date.now(), this.currentStartId)
    } catch (e) {
      console.warn('[usage-trace] logAppEnd 失败:', e)
    }
    this.currentStartId = null
  }

  /**
   * 记录一次点击事件。
   * 调用方应先检查 usageTrackingEnabled，本方法不做开关判断（保持职责单一）。
   *
   * @param elementName data-name 属性值
   * @param windowType 窗口类型（'main' | 'chat' | 'prompts' | 'history' | 'advanced-panel' 等）
   * @param detail 可选附加详情（JSON 字符串）
   */
  logClick(elementName: string, windowType: string | null, detail?: unknown): void {
    if (!elementName) return
    this.db
      .prepare(
        'INSERT INTO click_logs (id, timestamp, element_name, window_type, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), Date.now(), elementName, windowType, detail != null ? JSON.stringify(detail) : null)
  }

  /**
   * 获取频次统计。
   * @param rangeDays 统计时间范围（天），默认 30
   */
  getFrequencyStats(rangeDays = 30): FrequencyStats {
    const since = Date.now() - rangeDays * 24 * 60 * 60 * 1000

    const totalClicksRow = this.db
      .prepare('SELECT COUNT(*) as c FROM click_logs WHERE timestamp > ?')
      .get(since) as { c: number }

    const hotkeyRow = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM click_logs
         WHERE timestamp > ? AND (element_name LIKE '%hotkey%' OR element_name LIKE '%shortcut%')`,
      )
      .get(since) as { c: number }

    const apiChatRow = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM click_logs
         WHERE timestamp > ? AND (element_name LIKE 'chat.send%' OR element_name LIKE 'chat.stream%')`,
      )
      .get(since) as { c: number }

    const topElementsRows = this.db
      .prepare(
        `SELECT element_name as name, COUNT(*) as c
         FROM click_logs WHERE timestamp > ?
         GROUP BY element_name ORDER BY c DESC LIMIT 20`,
      )
      .all(since) as Array<{ name: string; c: number }>

    const byWindowTypeRows = this.db
      .prepare(
        `SELECT window_type as wt, COUNT(*) as c
         FROM click_logs WHERE timestamp > ? AND window_type IS NOT NULL
         GROUP BY window_type ORDER BY c DESC`,
      )
      .all(since) as Array<{ wt: string; c: number }>

    const appStartsRows = this.db
      .prepare('SELECT * FROM app_starts ORDER BY start_time DESC LIMIT 50')
      .all() as AppStartRow[]

    return {
      totalClicks: totalClicksRow.c,
      hotkeyCount: hotkeyRow.c,
      apiChatCount: apiChatRow.c,
      topElements: topElementsRows.map((r) => ({ name: r.name, count: r.c })),
      byWindowType: byWindowTypeRows.map((r) => ({ windowType: r.wt, count: r.c })),
      appStarts: appStartsRows.map(rowToAppStart),
    }
  }

  /** 列出最近的启动记录 */
  listAppStarts(limit = 50): AppStart[] {
    const safeLimit = Math.max(1, Math.min(500, limit))
    const rows = this.db
      .prepare('SELECT * FROM app_starts ORDER BY start_time DESC LIMIT ?')
      .all(safeLimit) as AppStartRow[]
    return rows.map(rowToAppStart)
  }

  /** 列出最近的点击日志 */
  listClickLogs(limit = 200): ClickLog[] {
    const safeLimit = Math.max(1, Math.min(2000, limit))
    const rows = this.db
      .prepare('SELECT * FROM click_logs ORDER BY timestamp DESC LIMIT ?')
      .all(safeLimit) as ClickLogRow[]
    return rows.map(rowToClickLog)
  }

  /**
   * 清空所有使用统计数据（app_starts + click_logs）。
   * @returns 删除的总行数
   */
  clear(): number {
    const r1 = this.db.prepare('DELETE FROM click_logs').run()
    const r2 = this.db.prepare('DELETE FROM app_starts').run()
    this.currentStartId = null
    return r1.changes + r2.changes
  }
}
