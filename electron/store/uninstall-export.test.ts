import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import AdmZip from 'adm-zip'
import { decryptFile } from '../utils/file-crypto.js'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => name === 'userData' ? state.root : os.tmpdir(), getVersion: () => 'test' } }))
vi.mock('../modules/registry.js', () => ({ collectModuleDataFiles: () => ({ dbFiles: [], assetDirs: [] }), closeAllModuleDbs() {} }))
vi.mock('../../packages/backup-core/sessions.js', () => ({ captureOfflineCookies: async () => [], captureBackupSessions: async () => [] }))
import { exportForUninstall } from './uninstall-export.js'

const fixtures: string[] = []
afterEach(() => { for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-export-test-'))
  fixtures.push(parent)
  const root = path.join(parent, 'profile')
  state.root = root
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'edition-identity.json'), JSON.stringify({ schema: 1, edition: 'sidekickai-opensource' }))
  const db = new Database(path.join(root, 'settings.db'))
  db.exec("CREATE TABLE app_settings (key TEXT, value TEXT); INSERT INTO app_settings VALUES ('kept','yes')")
  db.close()
  return { parent, root, output: path.join(parent, 'backup.zip') }
}
describe('shared strict uninstall export', () => {
  it('retains selected asset names and original browser sidecars', async () => {
    const { root, output } = fixture()
    fs.mkdirSync(path.join(root, 'notes-assets'))
    fs.writeFileSync(path.join(root, 'notes-assets', 'LOCK'), 'user asset')
    fs.writeFileSync(path.join(root, 'Cookies'), 'browser file')
    fs.writeFileSync(path.join(root, 'Cookies-wal'), 'browser sidecar')
    await exportForUninstall(root, output)
    const archive = new AdmZip(output)
    expect(archive.readAsText('notes-assets/LOCK')).toBe('user asset')
    expect(archive.readAsText('Cookies-wal')).toBe('browser sidecar')
    expect(archive.getEntry('settings.db')).not.toBeNull()
  })
  it('preserves an existing encrypted destination', async () => {
    const { root, output } = fixture()
    fs.writeFileSync(output, 'original backup')
    await expect(exportForUninstall(root, output, 'test-password')).rejects.toThrow()
    expect(fs.readFileSync(output, 'utf8')).toBe('original backup')
  })
  it('rejects foreign ownership without creating an output', async () => {
    const { root, output } = fixture()
    fs.writeFileSync(path.join(root, 'edition-identity.json'), JSON.stringify({ edition: 'foreign' }))
    await expect(exportForUninstall(root, output)).rejects.toThrow(/ownership/)
    expect(fs.existsSync(output)).toBe(false)
  })
  it('produces a decryptable archive with the source-bound inventory and current data identity', async () => {
    const { parent, root, output } = fixture()
    fs.writeFileSync(path.join(root, 'manifest.json'), '{"original":true}')
    await exportForUninstall(root, output, 'test-password')
    const plain = path.join(parent, 'decrypted.zip')
    expect(decryptFile(output, plain, 'test-password')).toBe('concept-maintenance')
    const archive = new AdmZip(plain)
    expect(JSON.parse(archive.readAsText('manifest.json'))).toMatchObject({ format: 'sidekickai-backup', edition: 'concept', dataSchemaVersion: 1, entries: { 'settings.db': expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(archive.getEntry('settings.db')).not.toBeNull()
  })
})
