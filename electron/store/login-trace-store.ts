// electron/store/login-trace-store.ts — 平台登录痕迹 SQLite 持久化
//
// 从 chat-store.ts 拆分出来的职责子模块，仅负责 login_traces 表的 CRUD。
// 表结构（CREATE TABLE login_traces ...）仍由 ChatStore.initSchema 统一维护，
// 因为建表顺序与索引相关性较强，集中管理风险更低。
//
// ChatStore 通过 facade 委托模式调用本类，调用点（getChatStore().logLoginTrace() 等）
// 完全无需修改。

import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { LoginTrace } from '../shared/types.js'

interface LoginTraceRow {
  id: string
  profile_id: string
  platform: string | null
  login_url: string | null
  login_time: number
  session_data: string | null
}

/** 将数据库行映射为 LoginTrace 对象 */
function rowToLoginTrace(r: LoginTraceRow): LoginTrace {
  return {
    id: r.id,
    profileId: r.profile_id,
    platform: r.platform ?? undefined,
    loginUrl: r.login_url ?? undefined,
    loginTime: r.login_time,
    sessionData: r.session_data ?? undefined,
  }
}

/**
 * 平台登录痕迹 SQLite 持久化存储
 *
 * 所有方法同步执行（better-sqlite3 特性），在主进程内调用。
 * 由 ChatStore 持有实例并通过 facade 委托暴露。
 */
export class LoginTraceStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  logLoginTrace(
    trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>,
  ): void {
    const full: LoginTrace = {
      id: trace.id ?? randomUUID(),
      profileId: trace.profileId,
      platform: trace.platform,
      loginUrl: trace.loginUrl,
      loginTime: trace.loginTime ?? Date.now(),
      sessionData: trace.sessionData,
    }
    this.db
      .prepare(
        'INSERT INTO login_traces (id, profile_id, platform, login_url, login_time, session_data) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        full.id,
        full.profileId,
        full.platform ?? null,
        full.loginUrl ?? null,
        full.loginTime,
        full.sessionData ?? null,
      )
  }

  listLoginTraces(profileId?: string): LoginTrace[] {
    if (profileId) {
      const rows = this.db
        .prepare('SELECT * FROM login_traces WHERE profile_id = ? ORDER BY login_time DESC')
        .all(profileId) as LoginTraceRow[]
      return rows.map(rowToLoginTrace)
    }
    const rows = this.db
      .prepare('SELECT * FROM login_traces ORDER BY login_time DESC')
      .all() as LoginTraceRow[]
    return rows.map(rowToLoginTrace)
  }

  /** 清空登录痕迹（可选按 profileId 过滤），返回删除的行数 */
  clearLoginTraces(profileId?: string): number {
    if (profileId) {
      const result = this.db
        .prepare('DELETE FROM login_traces WHERE profile_id = ?')
        .run(profileId)
      return result.changes
    }
    const result = this.db.prepare('DELETE FROM login_traces').run()
    return result.changes
  }
}
