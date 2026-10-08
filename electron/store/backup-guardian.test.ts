import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', 1))
  return child
} }))

const originalArguments = [...process.argv]
const originalChannel = Object.fromEntries(['send', 'connected', 'disconnect'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
const directories: string[] = []
afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArguments)
  for (const [key, descriptor] of Object.entries(originalChannel)) {
    if (descriptor) Object.defineProperty(process, key, descriptor)
    else Reflect.deleteProperty(process, key)
  }
  vi.restoreAllMocks()
  vi.resetModules()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

it('records recovery required when a live replacement never reports readiness', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-guardian-test-'))
  directories.push(directory)
  const requestPath = path.join(directory, 'request.bin')
  process.argv.push('--backup-recovery-guardian', requestPath)
  fs.writeFileSync(path.join(directory, 'commit'), '')
  fs.writeFileSync(path.join(directory, 'resume-process.json'), JSON.stringify({ pid: 42 }))
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ state: 'complete', success: true, filePath: 'verified.zip' }))
  const request = { version: 1, executable: process.execPath, parentPid: 41, source: directory, identity: {}, args: [] }
  let receive: ((value: unknown) => void) | undefined
  const once = process.once.bind(process)
  vi.spyOn(process, 'once').mockImplementation(((name: string, listener: (...args: unknown[]) => void) => {
    if (name === 'message') { receive = listener; return process }
    if (name === 'disconnect') return process
    return once(name, listener)
  }) as typeof process.once)
  Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    send: { configurable: true, value: () => { queueMicrotask(() => receive?.(request)); return true } },
    disconnect: { configurable: true, value: () => {} },
  })
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 42) return true
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
  })
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => { now += 46000; return now })
  const { runBackupGuardian } = await import('../../packages/backup-core/guardian.js')
  expect(await runBackupGuardian()).toBe(1)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'guardian-recovery.json'), 'utf8'))).toMatchObject({ state: 'recovery-required', pid: 42 })
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'status.json'), 'utf8'))).toMatchObject({ success: true, filePath: 'verified.zip' })
})
