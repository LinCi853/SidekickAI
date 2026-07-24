// electron/store/store-paths.ts — store 层公共路径工具
//
// 抽取各 store 文件重复的 __dirname 与 STORE_CWD 计算，统一路径策略：
//   - dev 模式（ELECTRON_RENDERER_URL 存在）：写入项目内 .app-data/
//   - 生产便携版（exe 同级存在 portable.txt）：写入 exe 同级 data/ 目录
//   - 生产安装版：使用 electron-store 默认 userData 路径（cwd 传 undefined）
//
// 关键：getStoreCwd() 必须独立检测便携模式，不能依赖 main.ts 的
// redirectUserData()，因为 ESM import 阶段 store 就已初始化，早于
// redirectUserData() 顶层调用。否则便携版数据会误写入系统目录。

import path from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import Store from 'electron-store'
import { app } from 'electron'

/** 等价于 CommonJS __dirname，用于 ESM 获取当前模块目录 */
export function getModuleDirname(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

/**
 * 便携模式检测：exe 同级目录是否存在 portable.txt
 * 在 dev 模式下始终返回 false。
 */
let _portableCache: boolean | null = null
export function isPortableMode(): boolean {
  if (_portableCache !== null) return _portableCache
  // dev 模式不是便携版
  if (process.env.ELECTRON_RENDERER_URL) {
    _portableCache = false
    return false
  }
  try {
    const exePath = app.getPath('exe')
    const exeDir = path.dirname(exePath)
    const portableMarker = path.join(exeDir, 'portable.txt')
    _portableCache = existsSync(portableMarker)
  } catch {
    _portableCache = false
  }
  return _portableCache
}

/**
 * store 文件存储根目录：
 *   - dev 模式：项目内 .app-data/
 *   - 生产便携版：exe 同级 data/ 目录（数据跟随 exe 移动）
 *   - 生产安装版：undefined（electron-store 使用默认 userData 路径）
 */
export function getStoreCwd(): string | undefined {
  // dev 模式
  if (process.env.ELECTRON_RENDERER_URL) {
    return path.join(getModuleDirname(), '..', '..', '.app-data')
  }
  // 生产便携模式
  if (isPortableMode()) {
    const exePath = app.getPath('exe')
    const exeDir = path.dirname(exePath)
    return path.join(exeDir, 'data')
  }
  // 生产安装版：用 electron-store 默认
  return undefined
}

// =============================================================================
// Task 14: SQLite 基础设施
// =============================================================================

/**
 * SQLite 数据库文件路径解析（统一 notes-db / whiteboard-db / chat-store 三处重复逻辑）。
 *   - dev 模式：项目内 .app-data/<filename>（自动创建目录）
 *   - 生产便携版：exe 同级 data/<filename>（自动创建目录）
 *   - 生产安装版：userData/<filename>
 */
export function resolveSqlitePath(filename: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    const dir = path.join(getModuleDirname(), '..', '..', '.app-data')
    mkdirSync(dir, { recursive: true })
    return path.join(dir, filename)
  }
  if (isPortableMode()) {
    const exeDir = path.dirname(app.getPath('exe'))
    const dir = path.join(exeDir, 'data')
    mkdirSync(dir, { recursive: true })
    return path.join(dir, filename)
  }
  return path.join(app.getPath('userData'), filename)
}

/**
 * 创建 SQLite 数据库连接并完成基础配置（WAL + foreign_keys + schema 初始化）。
 * 统一 notes-db / whiteboard-db / chat-store 三处 Database 初始化样板。
 */
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

/**
 * 创建 electron-store 实例（统一 cwd: getStoreCwd() 重复）。
 *
 * @param opts.name 文件名（不含扩展名，如 'prompts' → prompts.json）
 * @param opts.defaults 默认值
 * @param opts.cwd 可选目录覆盖（默认使用 getStoreCwd()）
 */
export function createJsonStore<T extends Record<string, any>>(opts: {
  name: string
  defaults: T
  cwd?: string
}): Store<T> {
  return new Store<T>({
    name: opts.name,
    cwd: opts.cwd ?? getStoreCwd(),
    defaults: opts.defaults,
  })
}

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

/**
 * 创建通用 CRUD 操作集（基于 electron-store 的某个 key 下 T[] 数组）。
 * 特殊方法（如 profile.duplicate / ai-provider.touchLastUsed）仍由原 store 类实现。
 *
 * @param opts.store electron-store 实例（key 下存储 T[] 数组）
 * @param opts.key 数组在 store 中的字段名
 */
export function createCrudStore<T extends { id: string }>(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: Store<any>
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: Store<any>
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
