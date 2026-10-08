import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { runExportCli } from './export-cli.js'

const mocks = vi.hoisted(() => ({ export: vi.fn() }))
vi.mock('./backup-restore.js', () => ({ exportAllData: mocks.export }))
vi.mock('../../packages/backup-core/export.js', () => ({ retrySourceSnapshot: (run: () => unknown) => run() }))
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); vi.clearAllMocks() })

it('reads the password from the inherited stream without adding it to persisted requests or receipts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-export-channel-'))
  directories.push(directory)
  const request = path.join(directory, 'request.json')
  const result = path.join(directory, 'result.json')
  const target = path.join(directory, 'backup.sabackup')
  const secret = 'channel-only-fixture-secret'
  fs.writeFileSync(request, JSON.stringify({ outputPath: target, resultPath: result, strict: true, expectedDataRoot: directory, encrypt: true, passwordFromStdin: true }))
  mocks.export.mockResolvedValue({ success: true, filePath: target, strict: true, treeSha256: 'a'.repeat(64) })
  expect(await runExportCli(request, Readable.from([JSON.stringify({ password: secret })]))).toBe(0)
  expect(mocks.export.mock.calls[0][2]).toEqual({ password: secret })
  for (const file of [request, result]) expect(fs.readFileSync(file, 'utf8')).not.toContain(secret)
})

it('rejects an oversized secret channel before exporting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-export-channel-'))
  directories.push(directory)
  const request = path.join(directory, 'request.json')
  fs.writeFileSync(request, JSON.stringify({ outputPath: path.join(directory, 'backup.sabackup'), encrypt: true, passwordFromStdin: true }))
  expect(await runExportCli(request, Readable.from(['x'.repeat(65537)]))).toBe(1)
  expect(mocks.export).not.toHaveBeenCalled()
  expect(JSON.parse(fs.readFileSync(`${path.join(directory, 'backup.sabackup')}.result.json`, 'utf8')).error).toMatch(/channel.*large/)
})
