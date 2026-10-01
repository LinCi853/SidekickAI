// electron/store/backup-restore-encrypted.test.ts — 加密备份回环测试
//
// 覆盖：加密导出（SABK 头）、错误密码拒绝、正确密码解密恢复（含 sourceDeviceId
// 归因）、明文 zip 走 importAllDataDecrypted 的拒绝路径。补齐 backup-restore
// 编排层在此前只有组件级测试时的缺口；桌面 E2E（test:desktop）在真实应用层
// 覆盖同一链路，本文件提供快速回归锚点。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ paths: {} as Record<string, string> }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: (name: string) => fixture.paths[name], getVersion: () => '0.1.5', relaunch: vi.fn(), exit: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: { showErrorBox: vi.fn() },
  session: { defaultSession: { clearCache: async () => {}, clearAuthCache: async () => {}, clearStorageData: async () => {}, flushStorageData() {}, cookies: { flushStore: async () => {} } } },
}))
vi.mock('./chat-store.js', () => ({ closeChatStore() {} }))
vi.mock('./whiteboard-db.js', () => ({ closeWhiteboardDb() {} }))
vi.mock('./notes-db.js', () => ({ closeNotesDb() {} }))
vi.mock('./bookmark-store.js', () => ({ closeBookmarkStore() {} }))
vi.mock('./module-state-store.js', () => ({ closeModuleStateDb() {}, createSqliteJsonStore() {}, clearSqliteStore() {} }))
vi.mock('./profile-store.js', () => ({ profileStore: { list: () => [] } }))
vi.mock('./device-id.js', () => ({ getDeviceId: () => 'fixture-device' }))
vi.mock('./search-history-store.js', () => ({ closeSearchHistoryStore() {} }))
vi.mock('./browser-download-store.js', () => ({ closeBrowserDownloadStore() {} }))
vi.mock('./nav-history-store.js', () => ({ closeNavHistoryStore() {} }))
vi.mock('./accumulated-links-store.js', () => ({ accumulatedLinksStore: { close() {} } }))
vi.mock('./install-config-seed.js', () => ({ stampInstallConfigHashAfterImport() {} }))
vi.mock('../modules/registry.js', () => ({ collectModuleDataFiles: () => ({ dbFiles: [], assetDirs: [] }), closeAllModuleDbs() {} }))
import { exportAllData, importAllData, importAllDataDecrypted } from './backup-restore'
import { applyPendingRestore, finishPendingRestore } from '../../packages/backup-core/transaction'
import { setImportingData } from './import-guard'

const PASSWORD = '测试密码-pw'
let root: string

beforeEach(() => {
  setImportingData(false)
  vi.stubEnv('SIDEKICK_DATA_DIR', '')
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-encrypted-backup-'))
  fixture.paths = { userData: path.join(root, 'data'), temp: root }
})
afterEach(() => {
  setImportingData(false)
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

/** 在数据目录种子 settings.db（sentinel 键），返回其路径 */
function seedData(value: string): string {
  const directory = fixture.paths.userData
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'settings.db')
  const db = new Database(file)
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT OR REPLACE INTO app_settings VALUES (?, ?)').run('sentinel', value)
  db.close()
  return file
}
function sentinel(file: string): string {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('sentinel') as { value: string }).value }
  finally { db.close() }
}

describe('加密备份回环（exportAllData + importAllDataDecrypted）', () => {
  it('加密导出产生 SABK 头文件；错误密码拒绝且数据原样保留', async () => {
    seedData('original')
    const backup = path.join(root, 'backup.sabackup')
    expect(await exportAllData(backup, { basicData: true, cookies: false, indexedDB: false, cache: false }, { password: PASSWORD }))
      .toMatchObject({ success: true, filePath: backup })
    // SABK 魔数 + 版本头（file-crypto 格式约定）
    expect(fs.readFileSync(backup).subarray(0, 4).toString('ascii')).toBe('SABK')

    // 错误密码：拒绝导入，原数据不被触碰
    const wrong = await importAllDataDecrypted(backup, 'wrong-password')
    expect(wrong).toMatchObject({ success: false, error: '密码错误或文件损坏' })
    expect(sentinel(path.join(fixture.paths.userData, 'settings.db'))).toBe('original')
  })

  it('正确密码解密恢复 sentinel 与设备归因', async () => {
    seedData('before-encrypt')
    const backup = path.join(root, 'backup.sabackup')
    await exportAllData(backup, { basicData: true, cookies: false, indexedDB: false, cache: false }, { password: PASSWORD })

    // 换一批新数据，恢复后应回到备份时的快照
    const db = new Database(path.join(fixture.paths.userData, 'settings.db'))
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('drifted', 'sentinel')
    db.close()

    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const result = await importAllDataDecrypted(backup, PASSWORD)
    expect(result).toMatchObject({ success: true, sourceDeviceId: 'fixture-device' })
    expect(sentinel(path.join(fixture.paths.userData, 'settings.db'))).toBe('drifted')
    expect(applyPendingRestore(fixture.paths.userData).restored).toBe(true)
    finishPendingRestore(fixture.paths.userData)
    expect(sentinel(path.join(fixture.paths.userData, 'settings.db'))).toBe('before-encrypt')
  })

  it('明文 zip 与加密标记：importAllData 识别加密备份并要求密码；解密器拒绝非 SABK 文件', async () => {
    seedData('plain')
    const plainZip = path.join(root, 'plain.zip')
    expect(await exportAllData(plainZip, { basicData: true, cookies: false, indexedDB: false, cache: false }))
      .toMatchObject({ success: true })
    expect(fs.readFileSync(plainZip).subarray(0, 2).toString('ascii')).toBe('PK')
    // 加密解密器对非 SABK 文件按"密码错误或损坏"拒绝，不做部分导入
    const refused = await importAllDataDecrypted(plainZip, PASSWORD)
    expect(refused).toMatchObject({ success: false, error: '密码错误或文件损坏' })

    // 加密备份直接走 importAllData（无密码）→ 提示需要密码
    const backup = path.join(root, 'backup.sabackup')
    await exportAllData(backup, { basicData: true, cookies: false, indexedDB: false, cache: false }, { password: PASSWORD })
    expect(await importAllData(backup)).toMatchObject({ success: false, encrypted: true })
    expect(sentinel(path.join(fixture.paths.userData, 'settings.db'))).toBe('plain')
  })
})
