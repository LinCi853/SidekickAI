// electron/store/module-state-store.ts — 模块状态持久化存储（SQLite settings.db）
//
// 决策 0.4：plugins、app-settings 等 JSON 尽量入库。模块状态从第一天起存 SQLite，
// 不创建 plugins.json。库文件：settings.db（安装版 userData / 便携版 data / dev .app-data）。
//
// 表结构：
//   module_state(
//     id TEXT PRIMARY KEY,
//     enabled INTEGER NOT NULL DEFAULT 1,
//     installed INTEGER NOT NULL DEFAULT 1,
//     cleared_at INTEGER NOT NULL DEFAULT 0,
//     updated_at INTEGER NOT NULL DEFAULT 0
//   )
//
// 大模块（sizeLevel='large'）的「是否已安装」以 exe 同级的 plugins-manifest.json
// 为准（Phase 2 起由 NSIS 组件页写入）；便携版恒视为已安装；清单缺失时按已安装处理
// （保证现有构建不受影响）。

import Database from 'better-sqlite3'
import path from 'path'
import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import {
  createSingletonHolder,
  createSqliteDb,
  isPortableMode,
  MetaTable,
  resolveSqlitePath,
} from './store-paths.js'
import type { ModuleStateRow } from '../shared/types.js'

/** 大模块安装清单文件名（exe 同级；Phase 2 起由 NSIS 组件页写入） */
export const PLUGINS_MANIFEST_FILENAME = 'plugins-manifest.json'

/** 内存态模块状态记录（registry 使用） */
export interface ModuleStateRecord {
  id: string
  enabled: boolean
  installed: boolean
  clearedAt: number
  updatedAt: number
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_state (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      installed INTEGER NOT NULL DEFAULT 1,
      cleared_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

const holder = createSingletonHolder(
  () => createSqliteDb(resolveSqlitePath('settings.db'), initSchema),
  (db) => db.close(),
)

/** 获取 settings.db 连接（懒加载；仅在 app ready 后调用） */
export function getModuleStateDb(): Database.Database {
  return holder.get()
}

/** 关闭 settings.db（应用退出清理） */
export function closeModuleStateDb(): void {
  holder.close()
}

/** 应用设置 KV 表（app_settings：key → value TEXT，JSON 由调用方序列化） */
export function getAppSettingsTable(): MetaTable<string> {
  return new MetaTable<string>(getModuleStateDb(), 'app_settings')
}

/** 读取安装清单中某大模块是否已安装（便携版恒 true；清单缺失按已安装处理） */
export function isLargeModuleInstalledByManifestFile(moduleId: string): boolean {
  if (isPortableMode()) return true
  try {
    const markerPath = path.join(path.dirname(app.getPath('exe')), PLUGINS_MANIFEST_FILENAME)
    if (!existsSync(markerPath)) return true
    const data = JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<
      string,
      { installed?: boolean }
    >
    return data[moduleId]?.installed !== false
  } catch (err) {
    console.warn('[module-state] 读取安装清单失败，按已安装处理:', err)
    return true
  }
}

/** 读取模块状态（不存在返回 null，由 registry 补默认值） */
export function getModuleState(id: string): ModuleStateRecord | null {
  const row = getModuleStateDb()
    .prepare(
      'SELECT id, enabled, installed, cleared_at, updated_at FROM module_state WHERE id = ?',
    )
    .get(id) as ModuleStateRow | undefined
  if (!row) return null
  return {
    id: row.id,
    enabled: row.enabled === 1,
    installed: row.installed === 1,
    clearedAt: row.cleared_at,
    updatedAt: row.updated_at,
  }
}

/** 写入模块状态（upsert） */
export function saveModuleState(rec: ModuleStateRecord): void {
  getModuleStateDb()
    .prepare(
      `INSERT INTO module_state (id, enabled, installed, cleared_at, updated_at)
       VALUES (@id, @enabled, @installed, @clearedAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         installed = excluded.installed,
         cleared_at = excluded.cleared_at,
         updated_at = excluded.updated_at`,
    )
    .run({
      id: rec.id,
      enabled: rec.enabled ? 1 : 0,
      installed: rec.installed ? 1 : 0,
      clearedAt: rec.clearedAt,
      updatedAt: rec.updatedAt,
    })
}

// ============================================================================
// Phase 3：JSON 设置入库（决策 0.4 既有需求）
// ============================================================================

/**
 * SQLite KV 存储适配器。
 *
 * 每个 store 的数据存为 settings.db 中独立的 KV 表（单行 key='__data__', value=JSON）。
 */
export interface JsonStore<T> {
  get(key: string): any
  set(key: string, value: any): void
  delete(key: string): void
  has(key: string): boolean
}

export function createSqliteJsonStore<T extends Record<string, any>>(opts: {
  tableName: string
  defaults: T
}): JsonStore<T> {
  const table = new MetaTable<string>(getModuleStateDb(), opts.tableName)

  // 缓存：避免每次 get 都解析 JSON
  let cache: T | null = null

  function load(): T {
    if (cache) return cache
    const raw = table.get('__data__')
    if (raw) {
      try { cache = JSON.parse(raw) as T } catch { cache = { ...opts.defaults } }
    } else {
      cache = { ...opts.defaults }
      table.set('__data__', JSON.stringify(cache))
    }
    return cache
  }

  return {
    get(key: string): any {
      const data = load()
      return key in data ? (data as any)[key] : (opts.defaults as any)[key]
    },
    set(key: string, value: any): void {
      const data = { ...load(), [key]: value }
      cache = data as T
      table.set('__data__', JSON.stringify(data))
    },
    delete(key: string): void {
      const data = load()
      delete (data as any)[key]
      cache = data
      table.set('__data__', JSON.stringify(data))
    },
    has(key: string): boolean {
      const data = load()
      return key in data
    },
  }
}

/**
 * 清除某个 SQLite KV store 的全部数据（供模块清除数据时调用）。
 */
export function clearSqliteStore(tableName: string): void {
  try {
    getModuleStateDb().prepare('DELETE FROM ' + tableName).run()
    console.log('[store] 已清除 settings.db/' + tableName)
  } catch (err) {
    console.warn('[store] 清除 ' + tableName + ' 失败:', err)
  }
}

