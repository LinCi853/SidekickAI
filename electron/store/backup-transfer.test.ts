import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { classifyBackup } from '../../packages/backup-core/compatibility.js'
import { parseBackupManifest } from '../../packages/backup-core/format.js'
import { composeLimitedRestore, composeIncludedRestore } from '../../packages/backup-core/transfer.js'
import { inspectBackup, readImportBackup } from '../../packages/backup-core/import.js'
import { applyPendingRestore, finishPendingRestore, prepareRestoreDirectory, queuePreparedRestore } from '../../packages/backup-core/transaction.js'
import type { BackupEdition, BackupManifest } from '../../packages/backup-core/types.js'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
let temporary = ''
const key = Buffer.alloc(32, 7)
const otherKey = Buffer.alloc(32, 9)
const preset = { id: 'desktop', name: 'Desktop', platform: 'desktop', userAgent: 'fixture', viewport: { width: 1000, height: 800 }, devicePixelRatio: 1 }
const profile = { ...preset, id: 'source', name: 'AI account', devicePreset: 'desktop', isAIPlatform: true, isBuiltIn: false, aiPlatformId: 'chatgpt', aiPlatformUrl: 'https://example.test', createdAt: 1, updatedAt: 2 }
const defaults = { profile, presets: [preset] }
const options = { basicData: true, cookies: true, indexedDB: true, cache: true }
const cookie: Electron.Cookie = { name: 'token', value: 'login', domain: 'example.test', path: '/', sameSite: 'lax', hostOnly: true, secure: true, httpOnly: true, session: true }
const manifest = (edition: BackupEdition, extra: Partial<BackupManifest> = {}): BackupManifest => ({ format: 'sidekickai-backup', formatVersion: 1, edition, dataSchemaVersion: 1, appVersion: '0.1.5', deviceId: 'fixture', exportedAt: '', options, entries: {}, ...extra })
const make = (name: string) => { const directory = path.join(temporary, name); fs.mkdirSync(directory); return directory }
function write(directory: string, relative: string, value: string) { const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
function seed(directory: string, rows: Record<string, unknown>) {
  const db = new Database(path.join(directory, 'settings.db'))
  try {
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    db.prepare('INSERT INTO app_settings VALUES (?,?)').run('appearance', 'target-only')
    for (const [table, row] of Object.entries(rows)) {
      db.exec(`CREATE TABLE ${table} (key TEXT PRIMARY KEY,value TEXT NOT NULL)`)
      db.prepare(`INSERT INTO ${table} VALUES (?,?)`).run('__data__', JSON.stringify(row))
    }
  } finally { db.close() }
}
function read(directory: string, table: string): any {
  const db = new Database(path.join(directory, 'settings.db'), { readonly: true })
  try { return JSON.parse((db.prepare(`SELECT value FROM ${table} WHERE key='__data__'`).get() as { value: string }).value) }
  finally { db.close() }
}
function encrypt(value: string, secret: Buffer): string {
  const iv = Buffer.alloc(12, 1), cipher = createCipheriv('aes-256-gcm', secret, iv)
  return 'aes:' + Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64')
}
function decrypt(value: string, secret: Buffer): string {
  const bytes = Buffer.from(value.slice(4), 'base64'), cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12))
  cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString()
}
function archive(directory: string, identity: BackupManifest): string {
  const zip = new AdmZip(), bytes = fs.readFileSync(path.join(directory, 'settings.db'))
  zip.addFile('settings.db', bytes)
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ ...identity, entries: { 'settings.db': createHash('sha256').update(bytes).digest('hex') } })))
  const file = path.join(temporary, 'backup.zip'); zip.writeZip(file); return file
}
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-transfer-')) })
afterEach(() => { fs.rmSync(temporary, { recursive: true, force: true }) })

describe('backup compatibility', () => {
  it('keeps omitted roots under the included-entry restore contract and replaces included database sidecars', () => {
    const root = make('target'), staged = prepareRestoreDirectory(root)
    seed(root, {}); seed(staged, {})
    write(root, 'plugins/retained', 'target plugin'); write(root, 'settings.db-wal', 'obsolete sidecar')
    write(staged, 'manifest.json', JSON.stringify(manifest('concept', { options: { ...options, cookies: false } })))
    queuePreparedRestore(root, staged)
    expect(applyPendingRestore(root, undefined, composeIncludedRestore).restored).toBe(true)
    expect(fs.readFileSync(path.join(root, 'plugins/retained'), 'utf8')).toBe('target plugin')
    expect(fs.existsSync(path.join(root, 'settings.db-wal'))).toBe(false)
    finishPendingRestore(root)
  })
  it('uses data identity rather than product version distance', () => {
    expect(classifyBackup(manifest('community', { appVersion: '0.0.1' }), 'community').mode).toBe('full')
    expect(classifyBackup(manifest('concept'), 'community').reason).toBe('cross-edition')
    expect(() => classifyBackup(manifest('community', { dataSchemaVersion: 2 }), 'community')).toThrow('尚不支持的数据结构')
    expect(classifyBackup(manifest('community', { edition: undefined, legacy: true }), 'community').reason).toBe('unidentified')
  })
  it('inspects without changing the target and binds execution to the confirmed file', async () => {
    const source = make('source'); seed(source, {})
    const adapter = { edition: 'community' as const, defaults, validateFull() {} }
    const file = archive(source, manifest('concept'))
    const inspected = await inspectBackup(adapter, file)
    expect(inspected).toMatchObject({ success: true, mode: 'limited', reason: 'cross-edition' })
    fs.appendFileSync(file, 'changed')
    await expect(readImportBackup(adapter, file, make('staged'), undefined, inspected.fingerprint)).rejects.toThrow(/已变化/)
  })
  it('supports unmarked legacy profiles and rejects unknown containers and damaged inventory', async () => {
    const zip = new AdmZip(); zip.addFile('profiles.json', Buffer.from(JSON.stringify({ profiles: [profile] })))
    const file = path.join(temporary, 'legacy.zip'); zip.writeZip(file)
    const adapter = { edition: 'concept' as const, defaults, validateFull() {} }
    expect(await inspectBackup(adapter, file)).toMatchObject({ success: true, mode: 'limited', reason: 'unidentified' })
    zip.addFile('manifest.json', Buffer.from('{"format":"unknown"}')); zip.writeZip(file)
    expect((await inspectBackup(adapter, file)).success).toBe(false)
    const source = make('source'); seed(source, {}); const modern = archive(source, manifest('community'))
    const broken = new AdmZip(modern); broken.updateFile('settings.db', Buffer.from('corrupt')); broken.writeZip(modern)
    expect((await inspectBackup(adapter, modern)).error).toMatch(/integrity/)
  })
})

describe.each([['concept', 'community'], ['community', 'concept']] as const)('%s to %s limited restore', (sourceEdition, targetEdition) => {
  it('retains distinct same-platform webpage configurations and validates their composed sessions', () => {
    const root = make('target'), staged = make('staged')
    const target = { ...profile, id: 'target-platform', isBuiltIn: true }
    const incoming = [{ ...profile, id: 'source-one', isBuiltIn: true }, { ...profile, id: 'source-two', isBuiltIn: true }]
    seed(root, { profiles: { profiles: [target] }, device_presets: { presets: [preset] } })
    seed(staged, { profiles: { profiles: incoming }, device_presets: { presets: [preset] } })
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition, { cookieSnapshots: incoming.map((item, index) => ({
      path: `Partitions/${item.id}`, cookies: [{ ...cookie, value: `session-${index}` }],
    })) })))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    const composed = parseBackupManifest(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')))
    const profiles = read(staged, 'profiles').profiles
    expect(profiles).toHaveLength(2)
    expect(composed.cookieSnapshots?.map(item => item.path)).toEqual(['Partitions/target-platform', 'Partitions/source-two'])
    expect(composed.cookieSnapshots?.map(item => item.cookies[0].value)).toEqual(['session-0', 'session-1'])
    expect(read(root, 'profiles').profiles).toEqual([target])
  })

  it.each([['Foo', 'foo'], ['foo', 'foo-browser']])('skips ambiguous source partition identities %s and %s', (first, second) => {
    const root = make('target'), staged = make('staged')
    seed(root, { profiles: { profiles: [] } })
    seed(staged, { profiles: { profiles: [{ ...profile, id: first }, { ...profile, id: second }, { ...profile, id: 'safe' }] } })
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    const result = parseBackupManifest(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')))
    expect(read(staged, 'profiles').profiles.map((item: any) => item.id)).toEqual(['safe'])
    expect(result.importReport?.skipped.map(item => item.id)).toEqual([first, second])
    expect(result.importReport?.imported.map(item => item.id)).toEqual(['safe'])
  })

  it('preserves target-only profiles and orphan session directories on identity collision', () => {
    const root = make('target'), staged = make('staged')
    const existing = { ...profile, id: 'source', isAIPlatform: false, isBuiltIn: true }
    seed(root, { profiles: { profiles: [existing] } })
    write(root, 'Partitions/orphan-browser/Local Storage/value', 'retained')
    seed(staged, { profiles: { profiles: [{ ...profile, isBuiltIn: true }, { ...profile, id: 'orphan' }] } })
    write(staged, 'Partitions/orphan-browser/Local Storage/value', 'incoming')
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    const result = parseBackupManifest(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')))
    expect(read(staged, 'profiles').profiles).toEqual([existing])
    expect(result.importReport?.skipped.map(item => item.id)).toEqual(['source', 'orphan'])
    expect(result.importReport?.imported).toEqual([])
    expect(fs.readFileSync(path.join(staged, 'Partitions/orphan-browser/Local Storage/value'), 'utf8')).toBe('retained')
    expect(fs.readFileSync(path.join(root, 'Partitions/orphan-browser/Local Storage/value'), 'utf8')).toBe('retained')
  })

  it('rejects overlapping target profiles before replacing either directory', () => {
    const root = make('target'), staged = make('staged')
    const existing = [{ ...profile, id: 'foo' }, { ...profile, id: 'foo-browser' }]
    seed(root, { profiles: { profiles: existing } })
    seed(staged, { profiles: { profiles: [{ ...profile, id: 'incoming' }] } })
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    expect(() => composeLimitedRestore(root, staged, targetEdition, defaults)).toThrow('Current browser session identities overlap')
    expect(read(root, 'profiles').profiles).toEqual(existing)
    expect(read(staged, 'profiles').profiles[0].id).toBe('incoming')
  })

  it('keeps same-platform mappings stable across two cold replacements', () => {
    const root = make('target')
    seed(root, { profiles: { profiles: [{ ...profile, id: 'target-platform', isBuiltIn: true }] } })
    const incoming = [{ ...profile, id: 'source-one', isBuiltIn: true }, { ...profile, id: 'source-two', isBuiltIn: true }]
    for (let attempt = 0; attempt < 2; attempt++) {
      const staged = prepareRestoreDirectory(root)
      seed(staged, { profiles: { profiles: incoming } })
      write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition, { cookieSnapshots: incoming.map((item, index) => ({
        path: `Partitions/${item.id}`, cookies: [{ ...cookie, value: `session-${index}` }],
      })) })))
      queuePreparedRestore(root, staged, 'limited')
      let result: BackupManifest | undefined
      expect(applyPendingRestore(root, (current, source) => {
        composeLimitedRestore(current, source, targetEdition, defaults)
        result = parseBackupManifest(JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')))
      }).restored).toBe(true)
      finishPendingRestore(root)
      expect(read(root, 'profiles').profiles.map((item: any) => item.id)).toEqual(['target-platform', 'source-two'])
      expect(result?.cookieSnapshots?.map(item => [item.path, item.cookies[0].value])).toEqual([
        ['Partitions/target-platform', 'session-0'], ['Partitions/source-two', 'session-1'],
      ])
    }
  })

  it('retains missing nested configuration fields from the target and fills new profiles from defaults', () => {
    const root = make('target'), staged = make('staged')
    const existing = { ...profile, viewport: { width: 900, height: 700 }, fingerprint: { seed: 42, canvas: 'block' } }
    seed(root, { profiles: { profiles: [existing] }, device_presets: { presets: [preset] } })
    seed(staged, { profiles: { profiles: [{ ...profile, viewport: { width: 1100 }, fingerprint: { canvas: 'real' } }, { ...profile, id: 'new', viewport: { width: 1200 } }] }, device_presets: { presets: [{ ...preset, viewport: { width: 1400 } }] } })
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    const profiles = read(staged, 'profiles').profiles
    expect(profiles[0].viewport).toEqual({ width: 1100, height: 700 })
    expect(profiles[0].fingerprint).toEqual({ seed: 42, canvas: 'real' })
    expect(profiles[1].viewport).toEqual({ width: 1200, height: 800 })
    expect(read(staged, 'device_presets').presets[0].viewport).toEqual({ width: 1400, height: 800 })
  })
  it('merges accounts and native partitions, preserves target data and reencrypts API secrets', () => {
    const root = make('target'), staged = make('staged')
    const builtin = { ...profile, id: 'Target-A', isBuiltIn: true, name: 'Existing account', catalogDefinition: { target: true } }
    seed(root, { profiles: { profiles: [builtin, { ...profile, id: 'second', name: 'Second account' }], defaultProfileId: 'second' }, device_presets: { presets: [preset] }, app_key: { key: key.toString('base64') }, ai_providers: { providers: [{ id: 'old', name: 'Old', apiKeyCipher: encrypt('old-key', key) }] }, tool_state: { draft: 'preserved' } })
    seed(staged, { profiles: { profiles: [{ ...profile, id: 'Source-A', isBuiltIn: true }, { ...profile, id: 'third', isBuiltIn: false }, { ...profile, id: 'browser', isAIPlatform: false }] }, device_presets: { presets: [preset] }, app_key: { key: otherKey.toString('base64') }, ai_providers: { providers: [{ id: 'new', name: 'API', protocol: 'openai', apiEndpoint: 'https://example.test/v1', model: 'model', apiKeyCipher: encrypt('new-key', otherKey) }] } })
    write(root, 'plugins/plugin.json', 'target-plugin'); write(root, 'Local Storage/ui', 'target-appearance')
    write(staged, 'plugins/plugin.json', 'source-plugin'); write(staged, 'Local Storage/ui', 'source-appearance')
    write(staged, 'Partitions/source-a/Local Storage/login', 'source-login'); write(staged, 'Partitions/source-a/IndexedDB/offline', 'offline')
    write(root, 'Partitions/target-a/Network/Cookies', 'old-cookie')
    write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition, { cookieSnapshots: [{ path: 'Partitions/source-a', cookies: [cookie] }, { path: '', cookies: [cookie] }] })))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    const result = read(staged, 'profiles')
    expect(result.profiles.map((item: any) => item.id)).toEqual(['Target-A', 'second', 'third'])
    expect(result.defaultProfileId).toBe('second')
    expect(result.profiles[0].catalogDefinition).toEqual({ target: true })
    expect(read(staged, 'app_key').key).toBe(key.toString('base64'))
    expect(decrypt(read(staged, 'ai_providers').providers.find((item: any) => item.id === 'new').apiKeyCipher, key)).toBe('new-key')
    expect(decrypt(read(staged, 'ai_providers').providers.find((item: any) => item.id === 'old').apiKeyCipher, key)).toBe('old-key')
    expect(read(staged, 'tool_state').draft).toBe('preserved')
    expect(fs.readFileSync(path.join(staged, 'plugins/plugin.json'), 'utf8')).toBe('target-plugin')
    expect(fs.readFileSync(path.join(staged, 'Local Storage/ui'), 'utf8')).toBe('target-appearance')
    expect(fs.readFileSync(path.join(staged, 'Partitions/target-a/Local Storage/login'), 'utf8')).toBe('source-login')
    expect(fs.existsSync(path.join(staged, 'Partitions/target-a/Network/Cookies'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(staged, 'manifest.json'), 'utf8')).cookieSnapshots).toEqual([{ path: 'Partitions/target-a', cookies: [cookie] }])
    expect(fs.readFileSync(path.join(root, 'Partitions/target-a/Network/Cookies'), 'utf8')).toBe('old-cookie')
  })
  it.each([undefined, ''])('preserves a missing API key (%s) and rejects an invalid source key before replacing target data', apiKeyCipher => {
    const root = make('target'), staged = make('staged')
    const provider = { id: 'api', name: 'API', protocol: 'openai', apiEndpoint: 'https://example.test', model: 'fixture' }
    seed(root, { app_key: { key: key.toString('base64') }, ai_providers: { providers: [{ ...provider, apiKeyCipher: encrypt('target-key', key) }] } })
    seed(staged, { ai_providers: { providers: [{ ...provider, apiKeyCipher }] } }); write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    composeLimitedRestore(root, staged, targetEdition, defaults)
    expect(decrypt(read(staged, 'ai_providers').providers[0].apiKeyCipher, key)).toBe('target-key')
    const bad = make('bad'); seed(bad, { ai_providers: { providers: [{ ...provider, apiKeyCipher: encrypt('bad', otherKey) }] } })
    write(bad, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
    composeLimitedRestore(root, bad, targetEdition, defaults)
    expect(JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8')).importReport.skipped).toHaveLength(1)
    expect(decrypt(read(root, 'ai_providers').providers[0].apiKeyCipher, key)).toBe('target-key')
  })
  it('combines the latest target at cold startup and remains stable on repeated import', () => {
    const root = make('target'); seed(root, { profiles: { profiles: [] }, tool_state: { value: 'before' } })
    for (let attempt = 0; attempt < 2; attempt++) {
      const staged = prepareRestoreDirectory(root)
      seed(staged, { profiles: { profiles: [profile] } }); write(staged, 'manifest.json', JSON.stringify(manifest(sourceEdition)))
      queuePreparedRestore(root, staged, 'limited')
      const db = new Database(path.join(root, 'settings.db')); db.prepare("UPDATE tool_state SET value=? WHERE key='__data__'").run(JSON.stringify({ value: 'latest' })); db.close()
      expect(applyPendingRestore(root, (current, incoming) => composeLimitedRestore(current, incoming, targetEdition, defaults)).restored).toBe(true)
      finishPendingRestore(root)
      expect(read(root, 'profiles').profiles).toHaveLength(1)
      expect(read(root, 'tool_state').value).toBe('latest')
    }
  })
})
