import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

/** 历史残留与运行时副本的统一前缀；与 scripts/clean-temp.cjs 保持一致。 */
const RUNTIME_PREFIXES = [
  'sidekickai-asset-',
  'sidekickai-code-preview',
  'sidekick-previews-',
  'ai-window-stt-local-',
  'sidekick-uia-text-',
  'sidekick-si-text-',
  'sidekick-ps-',
] as const

const ATTACHMENT_COPY_TTL_MS = 2 * 60 * 1000
const STALE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000

const pendingTimers = new Set<NodeJS.Timeout>()

function isManagedTempName(name: string): boolean {
  return RUNTIME_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * 资源管理器高亮需要副本在场，延迟再删；应用退出前由 sweep 兜底。
 */
export function scheduleAttachmentCopyExpiry(directory: string, ttlMs = ATTACHMENT_COPY_TTL_MS): void {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer)
    void rm(directory, { recursive: true, force: true }).catch(() => {})
  }, ttlMs)
  timer.unref()
  pendingTimers.add(timer)
}

/**
 * 启动时回收上次会话留下的预览/副本/识别临时物。只删 temp 根下受管前缀且超过 maxAge 的项。
 */
export async function sweepStaleRuntimeTemp(tempRoot: string, maxAgeMs = STALE_SWEEP_MAX_AGE_MS): Promise<number> {
  let removed = 0
  let entries: string[]
  try {
    entries = await readdir(tempRoot)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  for (const name of entries) {
    if (!isManagedTempName(name)) continue
    const target = path.join(tempRoot, name)
    try {
      const info = await stat(target)
      if (info.mtimeMs > cutoff) continue
    } catch {
      continue
    }
    try {
      await rm(target, { recursive: true, force: true })
      removed++
    } catch { /* locked by another session — try next time */ }
  }
  return removed
}

/** 供测试与退出路径使用：取消尚未触发的延迟删除。 */
export function cancelPendingAttachmentExpiry(): void {
  for (const timer of pendingTimers) clearTimeout(timer)
  pendingTimers.clear()
}
