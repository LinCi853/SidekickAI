import type { BackupEdition, BackupManifest, ImportDecision } from './types.js'
import { DATA_SCHEMA_VERSION } from './types.js'

export function classifyBackup(manifest: BackupManifest, target: BackupEdition): ImportDecision {
  const source = manifest.edition ?? (!manifest.legacy ? 'community' : undefined)
  if (!source) return { mode: 'limited', reason: 'unidentified', message: '此历史备份未标明产品路线，将仅导入网页登录态、AI 应用、设备预设和 API 配置；其他当前数据保留。' }
  if (source !== target) return { mode: 'limited', reason: 'cross-edition', message: '此备份来自另一产品路线，将仅导入网页登录态、AI 应用、设备预设和 API 配置；其他当前数据保留。' }
  if (manifest.dataSchemaVersion !== undefined && manifest.dataSchemaVersion !== DATA_SCHEMA_VERSION) return { mode: 'limited', reason: 'data-schema', message: '此备份的数据结构与当前版本不兼容，将仅导入可识别的网页登录态、AI 应用、设备预设和 API 配置；其他当前数据保留。' }
  return { mode: 'full', reason: 'same-edition', message: '将恢复备份包含的全部数据，替换对应的当前数据并自动重启。' }
}
