import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const fixture = vi.hoisted(() => ({ root: '', temporary: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'temp' ? fixture.temporary : fixture.root, getVersion: () => '0.1.5' },
  session: { defaultSession: { flushStorageData() {}, cookies: { flushStore: async () => {}, get: async () => [] } }, fromPartition: () => ({ flushStorageData() {}, cookies: { flushStore: async () => {}, get: async () => [] } }) },
}))
import { runExportCli } from './export-cli.js'

beforeEach(() => {
  fixture.temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-export-contract-'))
  fixture.root = path.join(fixture.temporary, 'data')
  fs.mkdirSync(fixture.root)
  fs.writeFileSync(path.join(fixture.root, 'edition-identity.json'), JSON.stringify({ schema: 1, edition: 'sidekickai-opensource' }))
  const db = new Database(path.join(fixture.root, 'settings.db'))
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.close()
})
afterEach(() => { fs.rmSync(fixture.temporary, { recursive: true, force: true }) })

it('returns the source-bound receipt required by both maintenance entry points', async () => {
  const outputPath = path.join(fixture.temporary, 'backup.zip')
  const requestPath = path.join(fixture.temporary, 'request.json')
  const resultPath = path.join(fixture.temporary, 'result.json')
  fs.writeFileSync(requestPath, JSON.stringify({ outputPath, resultPath, strict: true, expectedDataRoot: fixture.root, categories: ['basicData'] }))
  expect(await runExportCli(requestPath)).toBe(0)
  const receipt = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  expect(receipt).toMatchObject({ ok: true, strict: true, sourceRoot: fixture.root, skippedFiles: [], options: { basicData: true, cookies: false, indexedDB: false, cache: false } })
  expect(receipt.treeSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(receipt.sourceEntries['settings.db']).toMatch(/^[a-f0-9]{64}$/)
})
