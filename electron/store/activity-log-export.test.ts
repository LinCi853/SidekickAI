import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import path from 'node:path'
import { deferred } from '../../src/hooks/draft-hook-test-harness'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
import { ChatStore } from './chat-store'
import { openActivityLogFolder } from './activity-log-export'

const fixtureBase = path.resolve('build')
let directory: string
let store: ChatStore
let openPath: ReturnType<typeof vi.fn>
const logsDirectory = () => path.join(directory, 'logs')
const target = () => path.join(logsDirectory(), 'activity-records.json')
const readSnapshot = () => JSON.parse(fs.readFileSync(target(), 'utf8'))

beforeEach(() => {
  fs.mkdirSync(fixtureBase, { recursive: true })
  directory = fs.mkdtempSync(path.join(fixtureBase, 'activity-log-test-'))
  store = new ChatStore(path.join(directory, 'chat.db'))
  openPath = vi.fn(async () => '')
})
afterEach(() => {
  store.close()
  vi.restoreAllMocks()
  if (path.dirname(directory) !== fixtureBase || !path.basename(directory).startsWith('activity-log-test-'))
    throw new Error('Unexpected fixture cleanup path')
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('activity log snapshots', () => {
  it('exports every record without extending renderer limits or exporting private fields', async () => {
    for (let index = 0; index < 2105; index++) store.logWindowTrace(`window-${index}`, 'show', { privateDetail: 'window-private-sentinel' })
    store.logLoginTrace({ id: 'login-a', profileId: 'account-a', platform: '\u6d4b\u8bd5\u5e73\u53f0',
      loginUrl: 'https://fixture.test/login', loginTime: 12345, sessionData: 'private-session-sentinel' })
    fs.mkdirSync(logsDirectory())
    fs.writeFileSync(path.join(logsDirectory(), 'keep.txt'), 'unrelated log')
    expect(store.listWindowTraces(undefined, 5000)).toHaveLength(2000)
    const before = store.activityLogRecords()
    await openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)
    const snapshot = readSnapshot()
    expect(snapshot.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(snapshot.counts).toEqual({ loginRecords: 1, windowRecords: 2105 })
    expect(snapshot.loginRecords).toEqual(before.loginRecords)
    expect(snapshot.windowRecords).toEqual(before.windowRecords)
    expect(Object.keys(snapshot.loginRecords[0]).sort()).toEqual(['id', 'loginTime', 'loginUrl', 'platform', 'profileId'])
    expect(Object.keys(snapshot.windowRecords[0]).sort()).toEqual(['action', 'id', 'timestamp', 'windowId'])
    const bytes = fs.readFileSync(target(), 'utf8')
    expect(bytes).toContain('\u6d4b\u8bd5\u5e73\u53f0')
    expect(bytes).not.toContain('private-session-sentinel')
    expect(bytes).not.toContain('window-private-sentinel')
    expect(store.listLoginTraces()[0].sessionData).toBe('private-session-sentinel')
    expect(store.activityLogRecords()).toEqual(before)
    expect(fs.readFileSync(path.join(logsDirectory(), 'keep.txt'), 'utf8')).toBe('unrelated log')
    expect(fs.readdirSync(logsDirectory()).sort()).toEqual(['activity-records.json', 'keep.txt'])
    expect(openPath.mock.calls).toEqual([[logsDirectory()]])
  })

  it('writes readable empty arrays before opening the folder', async () => {
    openPath.mockImplementation(async () => {
      expect(readSnapshot()).toMatchObject({ counts: { loginRecords: 0, windowRecords: 0 }, loginRecords: [], windowRecords: [] })
      return ''
    })
    await openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)
    expect(fs.readFileSync(target(), 'utf8')).toContain('\n  "exportedAt":')
    expect(store.activityLogRecords()).toEqual({ loginRecords: [], windowRecords: [] })
  })

  it('shares a pending export and open operation and refreshes the next snapshot', async () => {
    const started = deferred<void>(), released = deferred<string>()
    const read = vi.fn(() => store.activityLogRecords())
    openPath.mockImplementationOnce(async () => { started.resolve(); return released.promise })
    const first = openActivityLogFolder(directory, read, openPath)
    const second = openActivityLogFolder(directory, read, openPath)
    expect(second).toBe(first)
    await started.promise
    store.logWindowTrace('main', 'show')
    expect(readSnapshot().counts.windowRecords).toBe(0)
    expect(openActivityLogFolder(directory, read, openPath)).toBe(first)
    released.resolve(''); await first
    await openActivityLogFolder(directory, read, openPath)
    expect(read).toHaveBeenCalledTimes(2)
    expect(openPath).toHaveBeenCalledTimes(2)
    expect(readSnapshot().counts.windowRecords).toBe(1)
  })

  it('rejects a shell error string and permits another request', async () => {
    openPath.mockResolvedValueOnce('Access denied')
    await expect(openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)).rejects.toThrow('Access denied')
    expect(readSnapshot().counts).toEqual({ loginRecords: 0, windowRecords: 0 })
    await openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)
    expect(openPath).toHaveBeenCalledTimes(2)
  })

  it.each(['write', 'rename'] as const)('preserves the previous snapshot and source records when %s fails', async failure => {
    store.logWindowTrace('main', 'show')
    store.logLoginTrace({ profileId: 'account-a', sessionData: 'retained-private-data' })
    const before = store.activityLogRecords()
    fs.mkdirSync(logsDirectory())
    const previous = Buffer.from('previous complete snapshot\n')
    fs.writeFileSync(target(), previous)
    fs.writeFileSync(path.join(logsDirectory(), 'keep.txt'), 'untouched')
    if (failure === 'write') {
      const open = promises.open.bind(promises)
      vi.spyOn(promises, 'open').mockImplementationOnce(async (file, flags, mode) => {
        const handle = await open(file, flags, mode)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (_data, options) => {
          await write('partial temporary bytes', options)
          throw new Error('Write unavailable')
        })
        return handle
      })
    } else vi.spyOn(promises, 'rename').mockRejectedValueOnce(new Error('Replacement unavailable'))
    await expect(openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)).rejects.toThrow()
    expect(fs.readFileSync(target())).toEqual(previous)
    expect(store.activityLogRecords()).toEqual(before)
    expect(store.listLoginTraces()[0].sessionData).toBe('retained-private-data')
    expect(fs.readFileSync(path.join(logsDirectory(), 'keep.txt'), 'utf8')).toBe('untouched')
    expect(fs.readdirSync(logsDirectory()).sort()).toEqual(['activity-records.json', 'keep.txt'])
    expect(openPath).not.toHaveBeenCalled()
    await openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)
    expect(readSnapshot().counts).toEqual({ loginRecords: 1, windowRecords: 1 })
  })

  it('retains an unrelated file when exclusive temporary creation collides', async () => {
    let collision: string | undefined
    vi.spyOn(promises, 'open').mockImplementationOnce(async file => {
      collision = String(file)
      fs.writeFileSync(collision, 'unrelated existing temporary name')
      throw Object.assign(new Error('Temporary name exists'), { code: 'EEXIST' })
    })
    await expect(openActivityLogFolder(directory, () => store.activityLogRecords(), openPath)).rejects.toThrow('Temporary name exists')
    expect(fs.readFileSync(collision!, 'utf8')).toBe('unrelated existing temporary name')
    expect(openPath).not.toHaveBeenCalled()
  })
})
