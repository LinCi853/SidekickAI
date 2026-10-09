import fs from 'node:fs'
import path from 'node:path'
import { assertOrdinaryPath } from './io.js'

interface SettingsDatabase {
  prepare(sql: string): { get(): unknown; all(): { value: unknown }[] }
  close(): void
}
interface SqliteModule { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SettingsDatabase }

const PASSWORD_REQUIRED = '备份包含 API 密钥材料，请设置备份密码后重新导出。'

function assertNoKey(bytes: unknown): void {
  if (typeof bytes !== 'string') throw new Error('无法验证备份的密钥材料，请设置备份密码。')
  const value: unknown = JSON.parse(bytes)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无法验证备份的密钥材料，请设置备份密码。')
  const key = (value as { key?: unknown }).key
  if (key !== undefined && key !== '') throw new Error(PASSWORD_REQUIRED)
}

/** Inspect only the captured snapshot; exported database bytes are never rewritten. */
export function assertUnencryptedCredentialsAbsent(directory: string): void {
  const file = path.join(directory, 'settings.db')
  assertOrdinaryPath(file)
  const sqlite = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined
  if (!sqlite) throw new Error('当前运行环境无法验证备份中的密钥材料，请设置备份密码。')
  const database = new sqlite.DatabaseSync(file, { readOnly: true })
  try {
    if (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_key'").get()) {
      for (const row of database.prepare('SELECT value FROM app_key').all()) assertNoKey(row.value)
    }
    if (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_providers'").get()) {
      for (const row of database.prepare('SELECT value FROM ai_providers').all()) {
        const value = JSON.parse(String(row.value)) as { providers?: { apiKeyCipher?: unknown }[] }
        if (!value || !Array.isArray(value.providers)) throw new Error('无法验证备份的凭据，请设置备份密码。')
        if (value.providers.some(provider => typeof provider.apiKeyCipher === 'string' && /^(plain|xor):/.test(provider.apiKeyCipher))) throw new Error(PASSWORD_REQUIRED)
      }
    }
  } finally { database.close() }
  const legacy = path.join(directory, 'app-key.json')
  if (fs.existsSync(legacy)) {
    assertOrdinaryPath(legacy)
    assertNoKey(fs.readFileSync(legacy, 'utf8'))
  }
}
