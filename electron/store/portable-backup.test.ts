import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { product } from '../../packages/product-contract'

const fixture = vi.hoisted(() => ({ paths: {} as Record<string, string> }))
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: (name: string) => fixture.paths[name], getVersion: () => '0.1.0-beta.5', relaunch: vi.fn(), exit: vi.fn() },
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
vi.mock('../modules/registry.js', () => ({ collectModuleDataFiles: () => ({ dbFiles: [], assetDirs: [] }) }))
import { estimateExportSizes, exportAllData, importAllData } from './backup-restore'
import { cleanCacheData, estimateCacheSize } from './cache-maintenance'

let root: string
beforeEach(() => {
  vi.stubEnv('SIDEKICK_DATA_DIR', '')
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-portable-backup-'))
})
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})
function settings(directory: string, value: string) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'settings.db')
  const db = new Database(file)
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO app_settings VALUES (?, ?)').run('sentinel', value)
  db.close()
  return file
}
function sentinel(file: string) {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('sentinel') as { value: string }).value }
  finally { db.close() }
}
function write(directory: string, name: string, bytes: string) {
  const file = path.join(directory, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}
function dualLayout(arch: 'x64' | 'arm64') {
  const runtime = path.join(root, product.portable.runtimes[arch])
  const shared = path.join(root, 'data')
  const decoy = path.join(runtime, 'data')
  fs.mkdirSync(runtime)
  fs.writeFileSync(path.join(runtime, 'portable.txt'), 'SidekickAI Dual Architecture Portable Marker\n')
  fs.writeFileSync(path.join(root, 'portable-layout.json'), JSON.stringify(product.portable))
  settings(shared, 'shared-root')
  settings(decoy, 'architecture-local-sentinel')
  write(shared, 'notes-assets/note.txt', 'shared-note')
  write(decoy, 'notes-assets/note.txt', 'wrong-note')
  write(shared, 'Cache/fixture', 'shared-cache')
  write(decoy, 'Cache/fixture', 'wrong-cache')
  fixture.paths = { exe: path.join(runtime, 'SidekickAI.exe'), userData: shared, temp: root }
  return { shared, decoy }
}

describe.each(['x64', 'arm64'] as const)('portable %s data operations', arch => {
  it('estimates, exports, and cleans the common data directory', async () => {
    const { shared, decoy } = dualLayout(arch)
    const estimate = await estimateExportSizes()
    expect(estimate.basicData).toBe(fs.statSync(path.join(shared, 'settings.db')).size + Buffer.byteLength('shared-note'))
    expect(estimateCacheSize()).toBe(Buffer.byteLength('shared-cache'))
    const backup = path.join(root, 'export.zip')
    expect(await exportAllData(backup, { basicData: true, cookies: false, indexedDB: false, cache: false })).toMatchObject({ success: true })
    const archive = new AdmZip(backup)
    expect(archive.readAsText('notes-assets/note.txt')).toBe('shared-note')
    const exportedDb = path.join(root, 'exported.db')
    fs.writeFileSync(exportedDb, archive.readFile('settings.db')!)
    expect(sentinel(exportedDb)).toBe('shared-root')
    await cleanCacheData()
    expect(fs.existsSync(path.join(shared, 'Cache'))).toBe(false)
    expect(fs.readFileSync(path.join(decoy, 'Cache/fixture'), 'utf8')).toBe('wrong-cache')
  })
  it('restores into the common data directory and leaves architecture-local sentinels untouched', async () => {
    const { shared, decoy } = dualLayout(arch)
    const incoming = settings(path.join(root, 'incoming'), 'restored-shared-root')
    const archive = new AdmZip()
    archive.addFile('settings.db', fs.readFileSync(incoming))
    const backup = path.join(root, 'restore.zip')
    archive.writeZip(backup)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    expect(await importAllData(backup)).toMatchObject({ success: true })
    expect(sentinel(path.join(shared, 'settings.db'))).toBe('restored-shared-root')
    expect(sentinel(path.join(decoy, 'settings.db'))).toBe('architecture-local-sentinel')
    const recovery = fs.readdirSync(root).find(name => name.startsWith('data.bak-'))!
    expect(sentinel(path.join(root, recovery, 'settings.db'))).toBe('shared-root')
  })
})
