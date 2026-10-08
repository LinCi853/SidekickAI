import { exportWithRecovery, finishBackupRecovery } from '../../packages/backup-core/recovery.js'
import { preparePermissionHandoff, quitForBackup } from '../edition-runtime.js'
import { exportAllData } from './backup/export.js'
import { getDataDir } from './backup/paths.js'
import { captureBackupWindows, restoreBackupWindows } from './backup-recovery-windows.js'
import type { ExportOptions } from './backup/types.js'


export async function exportApplicationData(target: string, options: ExportOptions, encrypt?: { password: string }) {
  if (!await preparePermissionHandoff()) return { success: false, error: '更改尚未全部保存，请等待当前操作完成。' }
  return exportWithRecovery({ source: getDataDir, export: exportAllData, quit: quitForBackup, captureWindows: captureBackupWindows }, target, options, encrypt, { cleanup: true })
}

export function resumeBackupRecovery(): Promise<void> { return finishBackupRecovery(restoreBackupWindows, getDataDir) }
