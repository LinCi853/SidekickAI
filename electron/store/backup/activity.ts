import { isImportingData } from '../import-guard.js'

let exports = 0
let restoring = false
export function hasActiveBackupOperations(): boolean { return exports > 0 || restoring || isImportingData }

/** A restore owns the data boundary until preparation finishes or the process exits. */
export async function runBackupOperation<T extends { success: boolean }>(kind: 'export' | 'restore', operation: () => Promise<T>): Promise<T | { success: false; error: string }> {
  if (isImportingData || restoring || kind === 'restore' && exports > 0) return { success: false, error: '数据迁移正在进行，请等待当前任务完成后重试。' }
  if (kind === 'restore') restoring = true
  else exports++
  try { return await operation() }
  finally { if (kind === 'restore') restoring = false; else exports-- }
}
