import path from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { portableRoot } from '../runtime-paths.js'

export function getModuleDirname(): string {
  return path.dirname(__filename)
}

export function isPortableMode(): boolean {
  return app.isPackaged === true && portableRoot(app.getPath('exe')) !== undefined
}

// Runtime initialization selects userData before any persistent store is imported.
export function getStoreCwd(): string {
  return app.getPath('userData')
}

export function resolveSqlitePath(filename: string): string {
  const directory = getStoreCwd()
  mkdirSync(directory, { recursive: true })
  return path.join(directory, filename)
}
export function createSqliteDb(
  dbPath: string,
  initSchema: (db: Database.Database) => void,
): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

/**
 * 单例持有器：懒加载实例 + 安全关闭。
 * 统一 notes-db / whiteboard-db / chat-store 的 _db / getDb / closeDb 单例管理。
 *
 * @param factory 创建实例的工厂函数（首次 get 时调用）
 * @param closeFn 关闭实例的函数（close 时调用，用于释放数据库连接等资源）
 */
export function createSingletonHolder<T>(
  factory: () => T,
  closeFn?: (instance: T) => void,
) {
  let instance: T | null = null
  return {
    /** 获取实例（不存在时通过 factory 创建） */
    get(): T {
      if (!instance) instance = factory()
      return instance
    },
    /** 获取当前实例（不存在时返回 null，不创建） */
    peek(): T | null {
      return instance
    },
    /** 关闭实例并清空引用（若提供了 closeFn 则先调用） */
    close(): void {
      if (instance) {
        if (closeFn) closeFn(instance)
        instance = null
      }
    },
    /** 清空引用（不调用 closeFn，仅用于测试或强制重置） */
    reset(): void {
      instance = null
    },
  }
}

/**
 * 通用键值元数据表（key → value TEXT）。
 * 统一 notes-db / whiteboard-db 的 notes_meta / whiteboard_meta 表操作。
 *
 * 表结构：CREATE TABLE <table> (key TEXT PRIMARY KEY, value TEXT NOT NULL)
 * V 默认为 string（直接存储原始字符串）；非 string 类型通过 JSON.stringify 落盘。
 */
export class MetaTable<V = string> {
  constructor(
    private db: Database.Database,
    private table: string,
  ) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    )
  }

  /** 读取指定 key 的值；不存在返回 null */
  get(key: string): V | null {
    const row = this.db
      .prepare(`SELECT value FROM ${this.table} WHERE key = ?`)
      .get(key) as { value: string } | undefined
    return (row?.value as unknown as V) ?? null
  }

  /** 写入指定 key 的值（upsert 语义） */
  set(key: string, value: V): void {
    const v = typeof value === 'string' ? value : JSON.stringify(value)
    this.db
      .prepare(
        `INSERT INTO ${this.table} (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, v)
  }

  /** 删除指定 key（不存在时无操作） */
  delete(key: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key)
  }
}

// =============================================================================
// Task 15: JSON store 基础设施
// =============================================================================

// createJsonStore 已移除（Phase 3：全部 JSON store 已迁入 SQLite settings.db）

// Phase 3：createSqliteJsonStore / clearSqliteStore 已迁移至 module-state-store.ts（此处仅保留引用）
export { createSqliteJsonStore, clearSqliteStore } from './module-state-store.js'

/**
 * 通用 CRUD 接口（基于 electron-store 的数组持久化）。
 * 适用于 prompt / preset / block-rules / profile / ai-provider 等列表型 store。
 */
export interface CrudStore<T extends { id: string }> {
  /** 读取全部条目 */
  list(): T[]
  /** 按 id 查找；不存在返回 undefined */
  get(id: string): T | undefined
  /** 新增或更新（upsert by id） */
  save(item: T): void
  /** 删除指定 id */
  delete(id: string): void
  /** 部分字段更新（shallow merge）；不存在时无操作 */
  update(id: string, patch: Partial<T>): void
}

/** store 通用接口（兼容 electron-store 与 createSqliteJsonStore 返回值） */
export interface StoreLike {
  get(key: string): any
  set(key: string, value: any): void
}
// JsonStore<T> 兼容 StoreLike（get/set 签名兼容）：
// createSqliteJsonStore 返回的 JsonStore<T> 的 get/set 接受 keyof T，
// 但 TS 允许 keyof T 隐式转为 string，因此兼容 StoreLike。

/**
 * 创建通用 CRUD 操作集（基于 store 的某个 key 下 T[] 数组）。
 * 特殊方法（如 profile.duplicate / ai-provider.touchLastUsed）仍由原 store 类实现。
 *
 * @param opts.store store 实例（兼容 electron-store 与 createSqliteJsonStore）
 * @param opts.key 数组在 store 中的字段名
 */
export function createCrudStore<T extends { id: string }>(opts: {
  store: StoreLike
  key: string
}): CrudStore<T> {
  const { store, key } = opts
  const getArr = (): T[] => (store.get(key) || []) as T[]
  return {
    list(): T[] {
      return getArr()
    },
    get(id: string): T | undefined {
      return getArr().find((x) => x.id === id)
    },
    save(item: T): void {
      const arr = getArr()
      const idx = arr.findIndex((x) => x.id === item.id)
      if (idx === -1) arr.push(item)
      else arr[idx] = item
      store.set(key, arr)
    },
    delete(id: string): void {
      const arr = getArr()
      store.set(key, arr.filter((x) => x.id !== id))
    },
    update(id: string, patch: Partial<T>): void {
      const arr = getArr()
      const idx = arr.findIndex((x) => x.id === id)
      if (idx === -1) return
      arr[idx] = { ...arr[idx], ...patch, id }
      store.set(key, arr)
    },
  }
}

/**
 * 首次启动填充默认数据；已存在数据时执行可选迁移。
 *
 * @param opts.store electron-store 实例
 * @param opts.key 数组字段名
 * @param opts.defaults 空数组时的默认填充数据（需含 id）
 * @param opts.migrate 非空时的迁移回调（负责自身持久化）
 * @returns true 表示填充了默认数据，false 表示已存在数据
 */
export function ensureDefaults<T extends { id: string }>(opts: {
  store: StoreLike
  key: string
  defaults: T[]
  migrate?: (existing: T[]) => void
}): boolean {
  const { store, key, defaults, migrate } = opts
  const existing = (store.get(key) || []) as T[]
  if (existing.length === 0) {
    store.set(key, defaults)
    return true
  }
  if (migrate) {
    migrate(existing)
  }
  return false
}
