import { app } from 'electron'
import fs from 'node:fs'
import { isSabkEncrypted } from '../../utils/file-crypto.js'
import { setImportingData, isImportingData } from '../import-guard.js'

import { getDataDir } from './paths.js'
import { inspectBackup, readImportBackup } from '../../../packages/backup-core/import.js'
import { importAdapter } from './transfer-adapter.js'
import { prepareRestoreDirectory, queuePreparedRestore, cancelPreparedRestore } from '../../../packages/backup-core/transaction.js'
import type { ImportResult } from './types.js'


export const inspectImportData = (filePath: string, password?: string) => inspectBackup(importAdapter(), filePath, password)

export async function importAllData(filePath: string, fingerprint?: string): Promise<ImportResult> {
  if (isSabkEncrypted(filePath)) return { success: false, encrypted: true, error: '需要密码解密' }
  return restoreBackup(filePath, undefined, fingerprint)
}

/** Prepare a complete replacement while the existing installation stays usable. */
async function restoreBackup(filePath: string, password?: string, fingerprint?: string): Promise<ImportResult> {
  let staged = ''
  let queued = false
  try {
      if (isImportingData) throw new Error('An application data restore is already pending.')
      const root = getDataDir()
      staged = prepareRestoreDirectory(root)
      const { manifest, decision } = readImportBackup(importAdapter(), filePath, staged, password, fingerprint)


      queuePreparedRestore(root, staged, decision.mode)
      try { app.relaunch() }
      catch (error) { cancelPreparedRestore(root); throw error }
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
    if (staged && !queued) {
      try { fs.rmSync(staged, { recursive: true, force: true }) }
      catch (error) { console.warn('[backup] Staging cleanup failed:', error) }
    }
  }
}

export async function importAllDataDecrypted(filePath: string, password: string, fingerprint?: string): Promise<ImportResult> {
  if (!isSabkEncrypted(filePath)) return { success: false, error: '密码错误或文件损坏' }
  return restoreBackup(filePath, password, fingerprint)
}
