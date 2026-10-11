import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import path from 'node:path'
import { deferred } from '../../src/hooks/draft-hook-test-harness'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '', getVersion: () => 'fixture' } }))
import { ChatStore } from './chat-store'
import { openActivityLogFolder } from './activity-log-export'
import { localLogDate, logDateRange } from '../shared/log-export'

const fixtureBase = path.resolve('build')
let directory: string, store: ChatStore, openPath: Mock<(directory: string) => Promise<string>>
const snapshot = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, 'activity-records.json'), 'utf8'))
const manifest = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
const exportLogs = (options = {}, sources: import('./activity-log-export').LogSource[] = []) =>
  openActivityLogFolder(directory, () => store.activityLogRecords(), openPath, options, sources)

beforeEach(() => {
  fs.mkdirSync(fixtureBase, { recursive: true })
  directory = fs.mkdtempSync(path.join(fixtureBase, 'activity-log-test-'))
  store = new ChatStore(path.join(directory, 'chat.db'))
  openPath = vi.fn(async (_directory: string) => '')
})
afterEach(() => {
  store.close(); vi.restoreAllMocks()
  if (path.dirname(directory) !== fixtureBase || !path.basename(directory).startsWith('activity-log-test-')) throw new Error('Unexpected fixture cleanup path')
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('dated software log exports', () => {
  it('exports all four event categories beyond renderer limits without private fields', async () => {
    for (let index = 0; index < 2105; index++) {
      store.logWindowTrace(`window-${index}`, 'show', { privateDetail: 'window-private-sentinel' })
      store.logClick(`fixture-${index}`, 'main', { text: 'click-private-sentinel' })
    }
    store.logAppStart()
    store.logLoginTrace({ profileId: 'account', loginUrl: 'https://fixture.test/login?token=private-token#secret', sessionData: 'private-session-sentinel' })
    const before = store.activityLogRecords()
    const result = await exportLogs()
    const data = snapshot(result.directory)
    expect(data.counts).toEqual({ loginRecords: 1, windowRecords: 2105, startupRecords: 1, clickRecords: 2105 })
    expect(data.loginRecords[0].loginUrl).toBe('https://fixture.test/login')
    expect(data.clickRecords[0]).not.toHaveProperty('detail')
    const content = JSON.stringify(data)
    for (const privateValue of ['window-private-sentinel', 'click-private-sentinel', 'private-session-sentinel', 'private-token']) expect(content).not.toContain(privateValue)
    expect(store.activityLogRecords()).toEqual(before)
    expect(openPath).toHaveBeenCalledWith(result.directory)
  })
  it('preserves earlier exports and unrelated files', async () => {
    fs.mkdirSync(path.join(directory, 'logs')); fs.writeFileSync(path.join(directory, 'logs', 'keep.txt'), 'keep')
    const first = await exportLogs(), original = fs.readFileSync(path.join(first.directory, 'activity-records.json'))
    store.logWindowTrace('main', 'show')
    const next = await exportLogs()
    expect(next.directory).not.toBe(first.directory)
    expect(fs.readFileSync(path.join(first.directory, 'activity-records.json'))).toEqual(original)
    expect(snapshot(next.directory).counts.windowRecords).toBe(1)
    expect(fs.readFileSync(path.join(directory, 'logs', 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('includes both local date boundaries and excludes adjacent days', async () => {
    const start = new Date(2026, 9, 3).getTime(), end = new Date(2026, 9, 4).getTime()
    for (const [id, loginTime] of [['before', start - 1], ['start', start], ['end', end - 1], ['after', end]] as const)
      store.logLoginTrace({ id, profileId: 'account', loginTime })
    const result = await exportLogs({ startDate: '2026-10-03', endDate: '2026-10-03' })
    expect(snapshot(result.directory).loginRecords.map((row: any) => row.id).sort()).toEqual(['end', 'start'])
    expect(logDateRange({ startDate: '2026-10-03', endDate: '2026-10-03' })).toEqual({ start, end })
  })
  it.each([{ startDate: '2026-02-30' }, { startDate: '2026-10-04', endDate: '2026-10-03' }, { directory: 'elsewhere' }, 'elsewhere'])('rejects invalid options %j before opening or writing', async options => {
    await expect(exportLogs(options as any)).rejects.toThrow()
    expect(openPath).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(directory, 'logs'))).toBe(false)
  })
  it('records exact persisted file sources and warns about unreadable files without copying config', async () => {
    const source = path.join(directory, 'maintenance'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'operation.log'), 'operation completed')
    fs.writeFileSync(path.join(source, 'config.json'), 'private-config')
    const result = await exportLogs({}, [
      { id: 'maintenance', directory: source }, { id: 'missing', directory: path.join(directory, 'absent') },
      { id: 'blocked', directory: source, file: 'config-directory.log' },
    ])
    expect(fs.readFileSync(path.join(result.directory, 'maintenance', 'operation.log'), 'utf8')).toBe('operation completed')
    expect(fs.existsSync(path.join(result.directory, 'maintenance', 'config.json'))).toBe(false)
    expect(manifest(result.directory).sources.some((item: any) => item.status === 'missing')).toBe(true)
    expect(manifest(result.directory).files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    fs.mkdirSync(path.join(source, 'config-directory.log'))
    const blocked = await exportLogs({}, [{ id: 'blocked', directory: source, file: 'config-directory.log' }])
    expect(blocked.warnings).toBe(1)
  })
  it('uses runtime dates and maintenance modification dates without reading adjacent request files', async () => {
    const source = path.join(directory, 'runtime'); fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, '2026-10-03-runtime.jsonl'), 'runtime record')
    fs.writeFileSync(path.join(source, '2026-10-02-runtime.jsonl'), 'old record')
    const operations = path.join(directory, 'operations'); fs.mkdirSync(path.join(operations, 'operation-a'), { recursive: true })
    const log = path.join(operations, 'operation-a', 'install.log'); fs.writeFileSync(log, 'installation record')
    fs.utimesSync(log, new Date(2026, 9, 3, 12), new Date(2026, 9, 3, 12))
    fs.writeFileSync(path.join(operations, 'operation-a', 'request.json'), 'private request')
    const result = await exportLogs({ startDate: '2026-10-03', endDate: '2026-10-03' }, [
      { id: 'runtime', directory: source, dated: true }, { id: 'operations', directory: operations, operationDirectories: true },
    ])
    expect(manifest(result.directory).files.map((item: any) => item.path).sort()).toEqual(['operations/operation-a/install.log', 'runtime/2026-10-03-runtime.jsonl'])
  })
  it('shares identical in-flight requests and keeps different date ranges separate', async () => {
    const gate = deferred<string>(), entered = deferred<void>()
    openPath.mockImplementationOnce(async () => { entered.resolve(); return gate.promise })
    const first = exportLogs(), second = exportLogs()
    expect(first).toBe(second); await entered.promise
    const ranged = exportLogs({ startDate: localLogDate() })
    expect(ranged).not.toBe(first)
    gate.resolve(''); await Promise.all([first, ranged])
    expect(openPath).toHaveBeenCalledTimes(2)
  })
  it('retains complete exports when opening fails and permits retry', async () => {
    openPath.mockResolvedValueOnce('Access denied')
    await expect(exportLogs()).rejects.toThrow('Access denied')
    expect(snapshot(openPath.mock.calls[0][0]).counts.windowRecords).toBe(0)
    await exportLogs(); expect(openPath).toHaveBeenCalledTimes(2)
  })
  it.each(['writeFile', 'rename'] as const)('preserves records and previous exports when %s fails', async method => {
    const first = await exportLogs(), before = store.activityLogRecords()
    vi.spyOn(promises, method).mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(exportLogs()).rejects.toThrow('Storage unavailable')
    expect(snapshot(first.directory).counts.windowRecords).toBe(0)
    expect(store.activityLogRecords()).toEqual(before)
    expect(fs.readdirSync(path.dirname(first.directory)).filter(name => name.startsWith('.pending-'))).toEqual([])
  })
})
