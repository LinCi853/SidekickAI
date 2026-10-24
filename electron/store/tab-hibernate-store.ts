// 历史休眠记录与图片的统计、保留清理；不再写入快照或卸载网页。

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type { EffectScope } from '../modules/effect-scope.js'
import { assertTrustedRenderer } from '../platform/security/trusted-renderer.js'
import type {
  TabHibernationEntry,
  TabHibernationPrunePolicy,
  TabHibernationPruneResult,
} from '../shared/tab-hibernation.types.js'
import { createSqliteJsonStore } from './module-state-store.js'

const ASSETS_DIR_NAME = 'tab-hibernation'

/**
 * 只统计和清理旧版生成的文件名：randomUUID 全小写十六进制 + 图片扩展名。
 * 正则不含路径分隔符、`..` 与 `%`，因此归一化、反斜杠与百分号编码穿越变体均不匹配。
 */
const ASSET_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg)$/

/** 休眠元数据持久化（独立 KV 表） */
const store = createSqliteJsonStore<{ entries: TabHibernationEntry[] }>({
  tableName: 'tab_hibernation',
  defaults: { entries: [] },
})

/** 读取休眠记录数组（KV store 返回 any，在此收口类型） */
function readEntries(): TabHibernationEntry[] {
  const entries = store.get('entries') as TabHibernationEntry[] | undefined
  return Array.isArray(entries) ? entries : []
}

function writeEntries(entries: TabHibernationEntry[]): void {
  store.set('entries', entries)
}

function assetFilePath(filename: string): string {
  return path.join(app.getPath('userData'), ASSETS_DIR_NAME, filename)
}

function removeSnapshot(snapshotPath: string | null | undefined): boolean {
  if (!snapshotPath || !ASSET_FILENAME.test(snapshotPath)) return false
  try { fs.unlinkSync(assetFilePath(snapshotPath)); return true } catch { return false }
}

/** 清理孤儿快照：目录中存在但没有任何休眠记录引用的文件 */
function removeOrphanSnapshots(referenced: ReadonlySet<string>): number {
  let removed = 0
  try {
    for (const name of fs.readdirSync(path.join(app.getPath('userData'), ASSETS_DIR_NAME))) {
      if (referenced.has(name) || !ASSET_FILENAME.test(name)) continue
      if (removeSnapshot(name)) removed += 1
    }
  } catch { /* 目录不可读时跳过，下次清理重试 */ }
  return removed
}

/** 历史休眠记录与快照的统计、保留清理。 */
export class TabHibernationStore {
  /** 全部休眠记录（按休眠时间倒序，最新在前） */
  list(): TabHibernationEntry[] {
    return [...readEntries()].sort((left, right) => right.hibernatedAt - left.hibernatedAt)
  }

  /**
   * 按保留策略清理：按张数上限截断（保留最新），并删除超过保留天数的记录，
   * 最后回收没有任何记录引用的孤儿快照。
   *
   * maxCount 为 0 或负数表示不按张数限制；retentionDays 为 0 表示不按时间清理。
   */
  prune(policy: TabHibernationPrunePolicy, now = Date.now()): TabHibernationPruneResult {
    // 非法数值回退到安全默认；maxCount<=0 与 retentionDays=0 一致表示「该项不限制」
    const rawMax = Number(policy?.maxCount)
    const maxCount = Number.isFinite(rawMax) ? Math.floor(rawMax) : 40
    const rawDays = Number(policy?.retentionDays)
    const retentionMs = (Number.isFinite(rawDays) ? Math.max(0, rawDays) : 7) * 86_400_000
    const keep: TabHibernationEntry[] = []
    let removed = 0
    let expired = 0
    for (const entry of this.list()) {
      const tooOld = retentionMs > 0 && now - entry.hibernatedAt > retentionMs
      const overCount = maxCount > 0 && keep.length >= maxCount
      if (tooOld || overCount) {
        removeSnapshot(entry.snapshotPath)
        removed += 1
        if (tooOld) expired += 1
        continue
      }
      keep.push(entry)
    }
    writeEntries(keep)
    const referenced = new Set(keep.map(entry => entry.snapshotPath).filter((name): name is string => Boolean(name)))
    return { removed, expired, orphans: removeOrphanSnapshots(referenced) }
  }

  /** 快照目录内实际文件的张数与总字节数（供设置页展示磁盘占用） */
  snapshotStats(): { snapshotCount: number; snapshotBytes: number } {
    // Count the actual disk files once, including orphan images. Metadata
    // alone neither occupies image space nor proves a live tab is asleep.
    const directory = path.join(app.getPath('userData'), ASSETS_DIR_NAME)
    let names: string[]
    try { names = fs.readdirSync(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { snapshotCount: 0, snapshotBytes: 0 }
      throw error
    }
    let snapshotCount = 0, snapshotBytes = 0
    for (const name of names) {
      if (!ASSET_FILENAME.test(name)) continue
      try {
        const info = fs.lstatSync(path.join(directory, name))
        if (!info.isFile()) continue
        snapshotCount += 1
        snapshotBytes += info.size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { snapshotCount, snapshotBytes }
  }
}

export const tabHibernationStore = new TabHibernationStore()

/** 历史数据只读统计；不再提供截图写入、卸载恢复或旧驱逐广播。 */
export function registerTabHibernationIPC(scope: EffectScope): void {
  scope.ipcHandle(IPC_CHANNELS.TAB_HIBERNATE_STATS, event => {
    assertTrustedRenderer(event)
    return { count: tabHibernationStore.list().length, ...tabHibernationStore.snapshotStats() }
  })
}
