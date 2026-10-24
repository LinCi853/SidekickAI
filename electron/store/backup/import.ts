import { runBackupOperation } from './activity.js'
import { prepareDataRestoreHandoff } from '../../edition-runtime.js'
import { app } from 'electron'
import fs from 'node:fs'
import { isSabkEncrypted } from '../../platform/security/file-crypto.js'
import { setImportingData, isImportingData } from '../import-guard.js'

import { getDataDir } from './paths.js'
import { inspectBackup, readImportBackup } from '../../../packages/backup-core/import.js'
import { importAdapter } from './transfer-adapter.js'
import { prepareRestoreDirectory, queuePreparedRestore, cancelPreparedRestore } from '../../../packages/backup-core/transaction.js'
import { flushWindowStateNow } from '../window-store.js'
import type { ImportResult } from './types.js'


export const inspectImportData = (filePath: string, password?: string) => inspectBackup(importAdapter(), filePath, password)

export async function importAllData(filePath: string, fingerprint?: string): Promise<ImportResult> {
  if (isSabkEncrypted(filePath)) return { success: false, encrypted: true, error: '需要密码解密' }
  return runBackupOperation('restore', () => restoreBackup(filePath, undefined, fingerprint))
}

/** Prepare a complete replacement while the existing installation stays usable. */
async function restoreBackup(filePath: string, password?: string, fingerprint?: string): Promise<ImportResult> {
  let staged = ''
  let queued = false
  let retainStaged = false
  let releaseHandoff: (() => void) | undefined
  try {
      if (isImportingData) throw new Error('An application data restore is already pending.')
      const root = getDataDir()
      staged = prepareRestoreDirectory(root)
      const { manifest, decision } = await readImportBackup(importAdapter(), filePath, staged, password, fingerprint)


      releaseHandoff = await prepareDataRestoreHandoff()
      // 交接已完成（渲染层已把窗口状态交上来），但 window-store 的落盘是 100ms 合并批次，
      // 下面直接 app.exit(0) 不走 will-quit，不在这里落地就会丢掉最后一批窗口状态。
      flushWindowStateNow()
      queuePreparedRestore(root, staged, decision.mode)
      try { app.relaunch() }
      catch (error) {
        try { cancelPreparedRestore(root) }
        catch { retainStaged = true; throw new Error('无法取消已准备的恢复，暂存与请求已保留；请关闭应用后重新打开以继续处理。') }
        throw error
      }
      queued = true
      setImportingData(true)
      setTimeout(() => {
        setTimeout(() => process.exit(0), 500).unref()
        app.exit(0)
      }, 120)
      return { success: true, sourceDeviceId: manifest.deviceId }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  } finally {
    if (!queued) releaseHandoff?.()
    if (staged && !queued && !retainStaged) {
      try { fs.rmSync(staged, { recursive: true, force: true }) }
      catch (error) { console.warn('[backup] Staging cleanup failed:', error) }
    }
  }
}

export async function importAllDataDecrypted(filePath: string, password: string, fingerprint?: string): Promise<ImportResult> {
  // 走「加密备份」入口却拿到明文包：如实说明格式不符，
  // 不要让用户以为是密码记错或文件损坏。
  if (!isSabkEncrypted(filePath)) {
    return { success: false, error: '该文件不是加密备份，请改用普通导入（无需密码）' }
  }
  return runBackupOperation('restore', () => restoreBackup(filePath, password, fingerprint))
}
