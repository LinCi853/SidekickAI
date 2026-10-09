import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { decryptFile, decryptFileStream, encryptFile, encryptFileStream } from '../../packages/backup-core/file-crypto.js'
import { exportBackup, type ExportAdapter } from '../../packages/backup-core/export.js'
import { exportTreeDigest } from '../../packages/backup-core/files.js'
import { validateTransfer } from '../../packages/backup-core/transfer.js'
import { resumeBackupJob } from '../../packages/backup-core/jobs.js'

let root: string
const password = 'isolated-backup-password'
const identity = 'isolated-device-identity'
const options = { basicData: true, cookies: false, indexedDB: false, cache: false }

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-security-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

function fixture(withKey: boolean) {
  const source = path.join(root, 'source')
  fs.mkdirSync(source)
  const settings = path.join(source, 'settings.db')
  const database = new Database(settings)
  const key = randomBytes(32), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update('isolated-api-secret'), cipher.final()])
  const provider = { id: 'fixture', name: 'Fixture', protocol: 'openai', apiEndpoint: 'https://example.test', model: 'fixture', apiKeyCipher: 'aes:' + Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64') }
  try {
    database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE app_key (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ai_providers (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database.prepare('INSERT INTO app_key VALUES (?, ?)').run('__data__', JSON.stringify({ key: withKey ? key.toString('base64') : '' }))
    database.prepare('INSERT INTO ai_providers VALUES (?, ?)').run('__data__', JSON.stringify({ providers: withKey ? [provider] : [] }))
  } finally { database.close() }
  const target = path.join(root, 'backup.zip')
  const adapter: ExportAdapter = {
    edition: 'concept', root: () => source, version: () => 'fixture', deviceId: () => identity, cookieTransfer: 'raw-profile',
    closeDatabases: async () => {}, collect: async () => [{ category: 'basicData', sourcePath: settings, archivePath: 'settings.db' }],
    validate: () => {}, treeDigest: exportTreeDigest, verifySources: () => {},
  }
  return { source, settings, target, adapter, key, provider, preparation: { tempRoot: path.join(root, 'jobs') } }
}

describe('backup credential boundary', () => {
  it('refuses an unencrypted archive containing an application key without replacing the destination', async () => {
    const entry = fixture(true)
    const original = fs.readFileSync(entry.settings)
    fs.writeFileSync(entry.target, 'previous backup')
    const result = await exportBackup(entry.adapter, entry.target, options, undefined, entry.preparation)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/密码/)
    expect(fs.readFileSync(entry.target, 'utf8')).toBe('previous backup')
    expect(fs.readFileSync(entry.settings)).toEqual(original)
  })

  it('keeps unencrypted backups available when no application key exists', async () => {
    const entry = fixture(false)
    expect((await exportBackup(entry.adapter, entry.target, options, undefined, entry.preparation)).success).toBe(true)
    expect(new AdmZip(entry.target).getEntry('settings.db')).not.toBeNull()
  })

  it.each(['plain:legacy-secret', 'xor:FRsWGQ=='])('requires a password when a legacy provider has no application key: %s', async apiKeyCipher => {
    const entry = fixture(false)
    const database = new Database(entry.settings)
    try { database.prepare('UPDATE ai_providers SET value=?').run(JSON.stringify({ providers: [{ ...entry.provider, apiKeyCipher }] })) }
    finally { database.close() }
    const result = await exportBackup(entry.adapter, entry.target, options, undefined, entry.preparation)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/密码/)
    expect(fs.existsSync(entry.target)).toBe(false)
  })

  it('requires encryption for a legacy key file as well as the current database', async () => {
    const entry = fixture(false)
    const file = path.join(entry.source, 'app-key.json')
    fs.writeFileSync(file, JSON.stringify({ key: entry.key.toString('base64') }))
    const collect = entry.adapter.collect
    entry.adapter.collect = async (...args) => [...await collect(...args), { category: 'basicData', sourcePath: file, archivePath: 'app-key.json' }]
    const result = await exportBackup(entry.adapter, entry.target, options, undefined, entry.preparation)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/密码/)
    expect(fs.existsSync(entry.target)).toBe(false)
  })

  it('preserves portable credentials in a password protected round trip', async () => {
    const entry = fixture(true)
    expect((await exportBackup(entry.adapter, entry.target, options, { password }, entry.preparation)).success).toBe(true)
    const decoded = path.join(root, 'decrypted.zip')
    expect(await decryptFileStream(entry.target, decoded, password)).toBe(identity)
    const restored = path.join(root, 'different-device')
    fs.mkdirSync(restored)
    fs.writeFileSync(path.join(restored, 'settings.db'), new AdmZip(decoded).readFile('settings.db')!)
    expect(validateTransfer(restored, { profile: {}, presets: [] }).imported).toEqual([{ category: 'providers', id: 'fixture' }])
  })

  it.each(['plain:legacy-secret', 'xor:FRsWGQ=='])('requires re-entry for legacy credential %s', apiKeyCipher => {
    const entry = fixture(true)
    const database = new Database(entry.settings)
    try { database.prepare('UPDATE ai_providers SET value=?').run(JSON.stringify({ providers: [{ ...entry.provider, apiKeyCipher }] })) }
    finally { database.close() }
    const result = validateTransfer(entry.source, { profile: {}, presets: [] })
    expect(result.imported).toEqual([])
    expect(result.skipped).toHaveLength(1)
  })

  it('applies the credential check again when resuming a retained unencrypted snapshot', async () => {
    const entry = fixture(true)
    const result = await exportBackup(entry.adapter, entry.target, options, undefined, entry.preparation)
    expect(result.success).toBe(false)
    const resumed = await resumeBackupJob(result.jobId!, entry.preparation)
    expect(resumed.success).toBe(false)
    expect(fs.existsSync(entry.target)).toBe(false)
  })
})

describe('authenticated backup envelope', () => {
  it('uses a fresh salt for every archive from the same device and password', async () => {
    const input = path.join(root, 'input'), first = path.join(root, 'first'), second = path.join(root, 'second')
    fs.writeFileSync(input, 'isolated archive contents')
    encryptFile(input, first, password, identity)
    await encryptFileStream(input, second, password, identity)
    const a = fs.readFileSync(first), b = fs.readFileSync(second)
    expect(a[4]).toBe(2)
    expect(a.readUInt32LE(5)).toBe(32)
    expect(a.subarray(13, 45)).not.toEqual(b.subarray(13, 45))
    expect(decryptFile(second, path.join(root, 'sync'), password)).toBe(identity)
    expect(await decryptFileStream(first, path.join(root, 'stream'), password)).toBe(identity)
  })

  it('rejects every changed header byte without publishing any plaintext', async () => {
    const input = path.join(root, 'input'), archive = path.join(root, 'archive'), changed = path.join(root, 'changed')
    fs.writeFileSync(input, 'authenticated contents')
    encryptFile(input, archive, password, identity)
    const original = fs.readFileSync(archive)
    expect(original[4]).toBe(2)
    const headerLength = 13 + 32 + Buffer.byteLength(identity) + 12 + 16
    for (let index = 0; index < headerLength; index++) {
      const bytes = Buffer.from(original); bytes[index] ^= 1
      fs.writeFileSync(changed, bytes)
      const destination = path.join(root, 'protected')
      fs.writeFileSync(destination, 'previous contents')
      expect(decryptFile(changed, destination, password), `sync byte ${index}`).toBeNull()
      expect(await decryptFileStream(changed, destination, password), `stream byte ${index}`).toBeNull()
      expect(fs.readFileSync(destination, 'utf8')).toBe('previous contents')
    }
  }, 20000)

  it('continues to read the published legacy envelope vector', async () => {
    const vector = JSON.parse(fs.readFileSync(path.resolve('packages/backup-core/sabk-v1-vector.json'), 'utf8'))
    const archive = path.join(root, 'legacy')
    fs.writeFileSync(archive, Buffer.from(vector.sabkHex, 'hex'))
    expect(decryptFile(archive, path.join(root, 'sync'), vector.password)).toBe(vector.deviceId)
    expect(await decryptFileStream(archive, path.join(root, 'stream'), vector.password)).toBe(vector.deviceId)
    expect(fs.readFileSync(path.join(root, 'sync')).toString('hex')).toBe(vector.plaintextHex)
  })
})
