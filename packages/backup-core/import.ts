import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { decryptFile, isSabkEncrypted } from './file-crypto.js'
import { extractBackupArchive } from './format.js'
import { classifyBackup } from './compatibility.js'
import { normalizeLegacySettings, validateSettingsDatabase, validateTransfer, type TransferDefaults } from './transfer.js'
import type { BackupEdition, BackupInspection, BackupManifest, ImportDecision } from './types.js'

export interface ImportAdapter {
  edition: BackupEdition
  defaults: TransferDefaults
  validateFull(directory: string): void
}
export interface PreparedBackup { manifest: BackupManifest; decision: ImportDecision; fingerprint: string }

export function backupFingerprint(file: string): string { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }

export function readImportBackup(adapter: ImportAdapter, file: string, directory: string, password?: string, expectedFingerprint?: string): PreparedBackup {
  const fingerprint = backupFingerprint(file)
  if (expectedFingerprint && fingerprint !== expectedFingerprint) throw new Error('备份文件已变化，请重新检查并确认导入。')
  let temporary = ''
  try {
    let input = file
    if (isSabkEncrypted(file)) {
      if (!password) throw new Error('需要密码解密')
      temporary = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-backup-decrypt-'))
      input = path.join(temporary, 'payload.zip')
      if (!decryptFile(file, input, password)) throw new Error('密码错误或文件损坏')
    }
    const manifest = extractBackupArchive(new AdmZip(input), directory)
    const decision = classifyBackup(manifest, adapter.edition)
    normalizeLegacySettings(directory)
    validateSettingsDatabase(path.join(directory, 'settings.db'))
    if (decision.mode === 'full') adapter.validateFull(directory)
    else validateTransfer(directory, adapter.defaults)
    if (decision.mode === 'limited' && manifest.options.cookies && manifest.cookieSnapshots === undefined) decision.message += '此旧备份没有可迁移 Cookie，部分网站可能需要重新登录。'
    if (backupFingerprint(file) !== fingerprint) throw new Error('备份文件已变化，请重新检查并确认导入。')
    manifest.entries['settings.db'] = createHash('sha256').update(fs.readFileSync(path.join(directory, 'settings.db'))).digest('hex')
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...manifest, restoreMode: decision.mode }))
    return { manifest, decision, fingerprint }
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }) }
}

export function inspectBackup(adapter: ImportAdapter, file: string, password?: string): BackupInspection {
  if (isSabkEncrypted(file) && !password) return { success: false, encrypted: true, error: '需要密码解密' }
  const directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'sidekick-backup-inspect-'))
  try {
    const { decision, fingerprint } = readImportBackup(adapter, file, directory, password)
    return { success: true, ...decision, fingerprint }
  } catch (error) { return { success: false, error: (error as Error).message } }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
