import fs from 'node:fs'
import path from 'node:path'
import { decryptFileStream, isSabkEncrypted } from './file-crypto.js'
import { readStreamingArchive } from './stream-archive.js'
import { assertOrdinaryPath, checkDiskSpace, createPrivateDirectory, hashFile } from './io.js'
import { sha256FileSync } from './files.js'
import { defaultBackupJobRoot } from './jobs.js'
import { classifyBackup } from './compatibility.js'
import { normalizeLegacySettings, validateSettingsDatabase, validateTransfer, type TransferDefaults } from './transfer.js'
import type { BackupEdition, BackupInspection, BackupManifest, ImportDecision, ImportReport } from './types.js'

export interface ImportAdapter {
  edition: BackupEdition
  defaults: TransferDefaults
  validateFull(directory: string): void
}
export interface PreparedBackup { manifest: BackupManifest; decision: ImportDecision; fingerprint: string; report: ImportReport }
export interface ImportPreparation { tempRoot?: string; signal?: AbortSignal; onProgress?: (bytes: number, total: number) => void }

export function backupFingerprint(file: string): string { return sha256FileSync(file) }

export async function readImportBackup(adapter: ImportAdapter, file: string, directory: string, password?: string, expectedFingerprint?: string, preparation: ImportPreparation = {}): Promise<PreparedBackup> {
  const fingerprint = await hashFile(file, preparation.signal)
  if (expectedFingerprint && fingerprint !== expectedFingerprint) throw new Error('备份文件已变化，请重新检查并确认导入。')
  let temporary = ''
  try {
    let input = file
    if (isSabkEncrypted(file)) {
      if (!password) throw new Error('需要密码解密')
      const temporaryRoot = preparation.tempRoot ?? path.dirname(directory)
      fs.mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 })
      assertOrdinaryPath(temporaryRoot, true)
      checkDiskSpace([{ path: temporaryRoot, bytes: fs.statSync(file).size, purpose: '备份解密' }])
      temporary = fs.mkdtempSync(path.join(temporaryRoot, 'sidekick-backup-decrypt-'))
      createPrivateDirectory(temporary)
      input = path.join(temporary, 'payload.zip')
      if (!await decryptFileStream(file, input, password, { signal: preparation.signal })) throw new Error('密码错误或文件损坏')
    }
    const manifest = await readStreamingArchive(input, { extractTo: directory, allowLegacy: true, signal: preparation.signal, onBytes: preparation.onProgress })
    const decision = classifyBackup(manifest, adapter.edition)
    const report: ImportReport = { imported: [], skipped: [], warnings: [] }
    normalizeLegacySettings(directory)
    validateSettingsDatabase(path.join(directory, 'settings.db'))
    if (decision.mode === 'full') adapter.validateFull(directory)
    else {
      const transfer = validateTransfer(directory, adapter.defaults)
      report.imported.push(...transfer.imported); report.skipped.push(...transfer.skipped); report.warnings.push(...transfer.warnings)
    }
    if (decision.mode === 'full') report.imported.push({ category: 'basicData' })
    if (decision.mode === 'limited' && manifest.options.cookies && manifest.cookieSnapshots === undefined) decision.message += '此旧备份没有可迁移 Cookie，部分网站可能需要重新登录。'
    if (await hashFile(file, preparation.signal) !== fingerprint) throw new Error('备份文件已变化，请重新检查并确认导入。')
    manifest.entries['settings.db'] = await hashFile(path.join(directory, 'settings.db'), preparation.signal)
    const settingsInventory = manifest.inventory?.find(entry => entry.path === 'settings.db')
    if (settingsInventory) { settingsInventory.sha256 = manifest.entries['settings.db']; settingsInventory.size = fs.statSync(path.join(directory, 'settings.db')).size }
    Object.assign(manifest, { restoreMode: decision.mode, importReport: report })
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest))
    return { manifest, decision, fingerprint, report }
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }) }
}

export async function inspectBackup(adapter: ImportAdapter, file: string, password?: string, preparation: ImportPreparation = {}): Promise<BackupInspection> {
  if (isSabkEncrypted(file) && !password) return { success: false, encrypted: true, error: '需要密码解密' }
  const root = preparation.tempRoot ?? path.join(defaultBackupJobRoot(), 'inspections')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  assertOrdinaryPath(root, true)
  const directory = fs.mkdtempSync(path.join(root, 'sidekick-backup-inspect-'))
  createPrivateDirectory(directory)
  try {
    const { decision, fingerprint, report } = await readImportBackup(adapter, file, directory, password, undefined, preparation)
    return { success: true, ...decision, fingerprint, report }
  } catch (error) { return { success: false, error: (error as Error).message } }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
