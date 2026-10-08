import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mock = vi.hoisted(() => ({ error: vi.fn(), message: vi.fn(), spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), setPath: vi.fn(), requestSingleInstanceLock: () => false }, dialog: { showErrorBox: mock.error, showMessageBox: mock.message } }))
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mock.spawn }))
const originalArguments = [...process.argv]
const directories: string[] = []

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArguments)
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetModules()
  vi.clearAllMocks()
})

it.each(['missing', 'invalid'])('releases backup admission after a %s recovery request', async state => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-job-'))
  directories.push(directory)
  const request = path.join(directory, 'request.bin')
  if (state === 'invalid') fs.writeFileSync(request, '{invalid')
  process.argv.push('--backup-snapshot-result', request)
  const { finishBackupRecovery, exportWithRecovery } = await import('../../packages/backup-core/recovery.js')
  const exporter = vi.fn(async () => ({ success: true }))
  const host = { source: () => directory, export: exporter, quit: vi.fn(), captureWindows: vi.fn() }
  const options = { basicData: true, cookies: false, indexedDB: false, cache: false }
  expect((await exportWithRecovery(host, 'unused.zip', options)).success).toBe(false)
  await expect(finishBackupRecovery(vi.fn(), host.source)).resolves.toBeUndefined()
  expect(mock.error).toHaveBeenCalledOnce()
  expect((await exportWithRecovery(host, 'unused.zip', options)).success).toBe(true)
  expect(exporter).toHaveBeenCalledOnce()
  expect(process.argv).not.toContain('--backup-snapshot-result')
})

function recoveryRequest(directory: string, source = directory) {
  const info = fs.lstatSync(source, { bigint: true })
  return { version: 1, executable: process.execPath, parentPid: 123456789, source,
    identity: { dev: String(info.dev), ino: String(info.ino) }, target: path.join(os.tmpdir(), 'unused-backup.zip'),
    options: { basicData: true, cookies: false, indexedDB: false, cache: false }, args: [], windows: {} }
}

it('does not open a second error dialog if the final result dialog rejects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-job-'))
  directories.push(directory)
  const request = path.join(directory, 'request.bin')
  fs.writeFileSync(request, JSON.stringify(recoveryRequest(directory)))
  fs.writeFileSync(path.join(directory, 'ready'), JSON.stringify({ pid: 123456789 }))
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ state: 'complete', success: false, error: 'Export failed' }))
  process.argv.push('--backup-snapshot-result', request)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Not running'), { code: 'ESRCH' }) })
  mock.message.mockRejectedValueOnce(new Error('Dialog rejected'))
  const { finishBackupRecovery } = await import('../../packages/backup-core/recovery.js')
  await expect(finishBackupRecovery(vi.fn(), () => directory)).resolves.toBeUndefined()
  expect(mock.message).toHaveBeenCalledOnce()
  expect(mock.error).not.toHaveBeenCalled()
  expect(fs.existsSync(directory)).toBe(false)
})

it.each(['source identity', 'application resume'])('reports one worker failure when result writing and %s both fail', async boundary => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-backup-job-'))
  directories.push(directory)
  const source = path.join(directory, 'source')
  fs.mkdirSync(source)
  const request = recoveryRequest(directory, source)
  if (boundary === 'source identity') request.identity.ino = 'invalid'
  const requestFile = path.join(directory, 'request.bin')
  fs.writeFileSync(requestFile, JSON.stringify(request))
  fs.writeFileSync(path.join(directory, 'commit'), 'ready')
  process.argv.push('--backup-snapshot-worker', requestFile)
  const descriptors = new Map(['send', 'connected', 'disconnect'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  const listeners = new Set(process.rawListeners('message'))
  Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    disconnect: { configurable: true, value: vi.fn() },
    send: { configurable: true, value: vi.fn(() => { setImmediate(() => { for (const listener of process.rawListeners('message')) if (!listeners.has(listener)) listener.call(process, request, undefined) }); return true }) },
  })
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Not running'), { code: 'ESRCH' }) })
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from).endsWith('status.tmp')) throw new Error('Status write failed')
    rename(from, to)
  })
  mock.spawn.mockImplementation(() => { throw new Error('Resume failed') })
  try {
    const { runBackupWorker } = await import('../../packages/backup-core/recovery.js')
    expect(await runBackupWorker(vi.fn())).toBe(1)
    expect(mock.error).toHaveBeenCalledOnce()
    expect(mock.message).not.toHaveBeenCalled()
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process, key, descriptor)
      else Reflect.deleteProperty(process, key)
    }
  }
})
