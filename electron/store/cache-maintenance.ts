// electron/store/cache-maintenance.ts — 缓存体积估算与清理
//
// 从 backup-restore.ts 拆出的缓存维护职责：仅清理离线缓存类目录
// （Service Worker / Cache / Code Cache / GPUCache / blob_storage / File System + Crashpad），
// 保留登录态与本地数据。存储分类常量与体积统计见 session-dirs.ts。

import { session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { profileStore } from '../browser/profile-store.js'
import { formatBytes } from './backup-restore.js'
import { PARTITION_CACHE_DIRS, getDataDir, getDirSize, getDirSizeAsync } from './session-dirs.js'
import { tabHibernationStore } from '../browser/tab-hibernate-store.js'
import type { TabHibernationPruneResult } from '../shared/tab-hibernation.types.js'

/** Disk sweep targets: Chromium cache subdirectories plus crash dumps. */
const DISK_SWEEP_DIR_NAMES = [...PARTITION_CACHE_DIRS, 'Crashpad']

/**
 * Error codes raised when a directory is still held by this process (renderer or
 * network service). They are expected, not failures, and must not be reported
 * as per-directory stack traces.
 */
const IN_USE_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/**
 * 估算当前缓存总体积（字节）。
 * 遍历 <dataDir>/ 根与 <dataDir>/Partitions/<id>/ 下的所有缓存子目录
 * （PARTITION_CACHE_DIRS：Service Worker / Cache / Code Cache / GPUCache / blob_storage / File System），
 * 不读取文件内容，仅 stat 累加。Crashpad 也按缓存处理（Chromium 崩溃转储，可安全清理）。
 */
export function estimateCacheSize(): number {
  const dataDir = getDataDir()
  let total = 0

  // 辅助：统计一个基础目录下的缓存子目录总体积
  const sumCacheDirs = (basePath: string): number => {
    let size = 0
    for (const dirName of PARTITION_CACHE_DIRS) {
      const dirPath = path.join(basePath, dirName)
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        size += getDirSize(dirPath)
      }
    }
    // Crashpad 也视为缓存（Chromium 崩溃转储目录，可安全清理）
    const crashpadPath = path.join(basePath, 'Crashpad')
    if (fs.existsSync(crashpadPath) && fs.statSync(crashpadPath).isDirectory()) {
      size += getDirSize(crashpadPath)
    }
    return size
  }

  // 默认 session（数据目录根级）
  total += sumCacheDirs(dataDir)

  // 各 profile session
  const partitionsDir = path.join(dataDir, 'Partitions')
  if (fs.existsSync(partitionsDir) && fs.statSync(partitionsDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(partitionsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        total += sumCacheDirs(path.join(partitionsDir, entry.name))
      }
    } catch {
      /* ignore */
    }
  }

  return total
}

/**
 * 异步估算缓存总体积（字节）。
 *
 * 与 estimateCacheSize 同口径。清理流程跑在启动路径上，不能用同步版本：
 * 同步遍历会占住 Electron 主线程，把等待主进程 IPC 的渲染层初始化一起推迟。
 */
async function estimateCacheSizeAsync(): Promise<number> {
  const dataDir = getDataDir()
  const basePaths = [dataDir, ...(await listPartitionBaseDirs(dataDir))]
  const sizes = await Promise.all(basePaths.map((basePath) => sumCacheDirsAsync(basePath)))
  return sizes.reduce((total, size) => total + size, 0)
}

/** 每个 profile session 的根目录（Partitions/<id>/）。 */
async function listPartitionBaseDirs(dataDir: string): Promise<string[]> {
  const partitionsDir = path.join(dataDir, 'Partitions')
  try {
    const entries = await fs.promises.readdir(partitionsDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(partitionsDir, entry.name))
  } catch {
    return []
  }
}

/** 单个 session 基础目录下的缓存子目录总体积。 */
async function sumCacheDirsAsync(basePath: string): Promise<number> {
  const sizes = await Promise.all(
    DISK_SWEEP_DIR_NAMES.map((dirName) => getDirSizeAsync(path.join(basePath, dirName))),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

interface CacheSweepResult {
  /** Directories removed without error. */
  removedDirs: number
  /** Directories still held by this process (expected, skipped silently). */
  inUseDirs: number
  /** Directories that failed for an unexpected reason. */
  failedDirs: number
}

/**
 * 磁盘兜底：递归删除缓存子目录 + Crashpad。
 *
 * 删除必须走异步 API。同步版本（fs.rmSync）会在 Electron 主进程主线程上逐个
 * 遍历并删除 150MB 级别的缓存目录，把主线程占住数秒；渲染层初始化需要向主进程
 * 发 IPC，因此整个首屏被推迟到清理结束之后。
 *
 * 失败分两类：目录正被本进程的渲染/网络子进程占用属于预期内，只计数不打印堆栈；
 * 其余异常逐条记录错误信息。
 */
async function sweepCacheDirectories(dataDir: string): Promise<CacheSweepResult> {
  const basePaths = [dataDir, ...(await listPartitionBaseDirs(dataDir))]
  const results = await Promise.all(basePaths.map((basePath) => sweepCacheBase(basePath)))
  return results.reduce(
    (total, result) => ({
      removedDirs: total.removedDirs + result.removedDirs,
      inUseDirs: total.inUseDirs + result.inUseDirs,
      failedDirs: total.failedDirs + result.failedDirs,
    }),
    { removedDirs: 0, inUseDirs: 0, failedDirs: 0 },
  )
}

/** 删除单个 session 基础目录下的全部缓存子目录。 */
async function sweepCacheBase(basePath: string): Promise<CacheSweepResult> {
  const result: CacheSweepResult = { removedDirs: 0, inUseDirs: 0, failedDirs: 0 }
  for (const dirName of DISK_SWEEP_DIR_NAMES) {
    const dirPath = path.join(basePath, dirName)
    if (!fs.existsSync(dirPath)) continue
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true })
      result.removedDirs += 1
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code && IN_USE_ERROR_CODES.has(code)) {
        result.inUseDirs += 1
        continue
      }
      result.failedDirs += 1
      console.warn(`[cache-maintenance] 删除缓存目录失败: ${dirPath}`, (err as Error).message)
    }
  }
  return result
}

/**
 * 收集需要清理的 session：默认 session + 各 profile partition。
 * 打开 partition session 会让 Chromium 持有该 partition 的缓存目录，
 * 因此磁盘兜底清理必须在这一步之前完成。
 */
function collectSessionsToClean(): Electron.Session[] {
  const sessions: Electron.Session[] = [session.defaultSession]
  try {
    for (const profile of profileStore.list()) {
      try {
        sessions.push(session.fromPartition(`persist:${profile.id}`))
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[cache-maintenance] 收集 partition sessions 失败:', err)
  }
  return sessions
}

/**
 * 清理缓存数据（仅缓存类目录与 session cache，保留登录态）。
 *
 * 清理流程：
 *   1. 记录清理前体积（异步统计，不占主线程）
 *   2. 磁盘兜底：递归删除缓存子目录 + Crashpad
 *      （处理 session API 未覆盖的 GPUCache/Crashpad 等），对 <dataDir>/ 根与每个
 *      Partitions/<id>/ 都执行。此步先于 session 打开，避免目录被自己锁住。
 *   3. 收集所有 session：defaultSession + persist:<profileId> partitions
 *   4. 每个 session 依次调用：
 *      - clearCache()：HTTP 缓存
 *      - clearAuthCache()：认证缓存
 *      - clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })：仅清 SW 与 Cache API
 *      （明确不传 cookies/localstorage/indexeddb/localfilesystem 等，保留登录态与本地数据）
 *   5. 返回实际释放的字节数（清理前后体积之差，而不是清理前的估算值）
 *
 * 注意：调用前需确保所有 webview 的关键页面上已加载完成（避免清理 SW 导致当前会话异常）。
 * 若 webview 正在使用，清理后下次导航会重新生成缓存，无副作用。
 */
export async function cleanCacheData(
  policy: { retentionDays: number; maxCount: number } = { retentionDays: 7, maxCount: 40 },
): Promise<{ cleanedBytes: number }> {
  const dataDir = getDataDir()
  const beforeBytes = await estimateCacheSizeAsync()
  console.log('[cache-maintenance] 开始清理缓存，当前体积:', formatBytes(beforeBytes))

  // 1. 磁盘兜底先做：此时尚未打开任何 partition session，profile 的缓存目录还没被
  //    Chromium 占用，能真正删掉；反过来先开 session 再删，目录必然被自己锁住。
  const sweep = await sweepCacheDirectories(dataDir)

  // 2. 再走 session API（仅缓存类）
  const sessionsToClean = collectSessionsToClean()
  await Promise.all(
    sessionsToClean.map(async (s) => {
      try {
        await s.clearCache()
      } catch {
        /* ignore */
      }
      try {
        await s.clearAuthCache()
      } catch {
        /* ignore */
      }
      try {
        await s.clearStorageData({
          storages: ['serviceworkers', 'cachestorage'],
        })
      } catch {
        /* ignore */
      }
    }),
  )

  // 3. 休眠占位快照：属于页面内容而非 Chromium 缓存，只在超过保留策略时清理。
  //    这里顺手按当前设置执行一次保留策略，避免手动清缓存后仍留着过期快照。
  try {
    const removed = pruneTabHibernationSnapshots(policy)
    if (removed.removed > 0) {
      console.log(
        '[cache-maintenance] 清理休眠占位快照:',
        removed.removed,
        '其中超期',
        removed.expired,
        '孤儿',
        removed.orphans,
      )
    }
  } catch (err) {
    console.warn('[cache-maintenance] 清理休眠占位快照失败:', err)
  }

  // 4. 报告实际释放量：清理前后体积之差，而不是清理前的估算快照。
  const afterBytes = await estimateCacheSizeAsync()
  const cleanedBytes = Math.max(0, beforeBytes - afterBytes)
  console.log(
    '[cache-maintenance] 缓存清理完成：实际释放',
    formatBytes(cleanedBytes),
    `（删除 ${sweep.removedDirs} 个目录，跳过 ${sweep.inUseDirs} 个占用中的目录，失败 ${sweep.failedDirs} 个）`,
  )
  return { cleanedBytes }
}

/**
 * 按传入的保留策略执行一次休眠快照清理。
 * 保留参数由调用方从应用设置读取（本模块不反向依赖设置存储，避免引入依赖环）。
 *
 * @param policy 保留天数与最大张数
 * @param now 时间基准（便于测试）
 */
export function pruneTabHibernationSnapshots(
  policy: { retentionDays: number; maxCount: number } = { retentionDays: 7, maxCount: 40 },
  now = Date.now(),
): TabHibernationPruneResult {
  return tabHibernationStore.prune(policy, now)
}
