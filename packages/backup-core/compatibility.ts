import type { BackupEdition, BackupManifest, ImportDecision } from './types.js'
import { DATA_SCHEMA_VERSION } from './types.js'

export function classifyBackup(manifest: BackupManifest, target: BackupEdition): ImportDecision {
  if (manifest.dataSchemaVersion !== undefined && (!Number.isSafeInteger(manifest.dataSchemaVersion) || manifest.dataSchemaVersion < 1 || manifest.dataSchemaVersion > DATA_SCHEMA_VERSION)) {
    throw new Error('此备份使用尚不支持的数据结构，未导入任何数据。请使用支持该结构的应用版本。')
  }
  const source = manifest.edition
  const compatible = source === target && manifest.dataSchemaVersion === DATA_SCHEMA_VERSION
  const mode = compatible ? 'full' : 'limited'
  const reason = !source ? 'unidentified' : source !== target ? 'cross-edition' : !compatible ? 'data-schema' : 'same-edition'
  const message = mode === 'full' ? '将恢复备份中的资料，完成后自动重启。'
    : '将迁移可用的通用配置和登录资料，保留其他当前数据。'
  return { mode, reason, message }
}
