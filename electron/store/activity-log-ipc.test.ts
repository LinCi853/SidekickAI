import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), invoke: vi.fn(), open: vi.fn(),
  export: vi.fn(), read: vi.fn(), directory: 'E:/isolated-log-profile',
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => fixture.handlers.set(channel, handler), on: vi.fn() },
  ipcRenderer: { invoke: fixture.invoke, on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => fixture.directory }, shell: { openPath: fixture.open },
  BrowserWindow: { getAllWindows: () => [] }, session: {}, dialog: {},
}))
vi.mock('./module-state-store.js', () => ({ getAppSettingsTable: vi.fn() }))
vi.mock('../hotkey/manager.js', () => ({ getHotkeyManagerInstance: vi.fn() }))
vi.mock('./default-config.js', () => ({ getDefaultAppSettings: () => ({}) }))
vi.mock('./chat-store.js', () => ({ getChatStore: () => ({ activityLogRecords: fixture.read }) }))
vi.mock('./activity-log-export.js', () => ({ openActivityLogFolder: fixture.export }))
import { registerAppSettingsIPC } from './app-settings-store'
import { appSettingsApi } from '../preload/appSettings'
import { openLogsFolder } from '../../src/lib/electron-api/settings'
import { IPC_CHANNELS } from '../shared/ipc-channels'

beforeEach(() => {
  fixture.handlers.clear(); vi.clearAllMocks()
  fixture.read.mockReturnValue({ loginRecords: [], windowRecords: [] })
  fixture.open.mockResolvedValue('')
  fixture.export.mockImplementation(async (directory: string, read: () => unknown, open: (directory: string) => Promise<string>) => {
    read(); await open(`${directory}/logs`)
  })
  registerAppSettingsIPC()
  fixture.invoke.mockImplementation(async (channel, ...args) => fixture.handlers.get(channel)!({}, ...args))
  vi.stubGlobal('window', { electron: appSettingsApi })
})
afterEach(() => { vi.unstubAllGlobals() })

it('passes the folder command through the actual renderer and preload bridge without a directory payload', async () => {
  await openLogsFolder()
  expect(fixture.invoke.mock.calls).toEqual([[IPC_CHANNELS.APP_OPEN_LOGS_FOLDER]])
  expect(fixture.export).toHaveBeenCalledTimes(1)
  expect(fixture.export).toHaveBeenCalledWith(fixture.directory, expect.any(Function), expect.any(Function))
  expect(fixture.read).toHaveBeenCalledTimes(1)
  expect(fixture.open.mock.calls).toEqual([[`${fixture.directory}/logs`]])
})

it('ignores renderer-supplied paths at the main-process handler', async () => {
  await fixture.handlers.get(IPC_CHANNELS.APP_OPEN_LOGS_FOLDER)!({}, 'E:/unrelated-directory')
  expect(fixture.export).toHaveBeenCalledWith(fixture.directory, expect.any(Function), expect.any(Function))
  expect(fixture.open.mock.calls).toEqual([[`${fixture.directory}/logs`]])
})

it('preserves backend rejection across the real bridge', async () => {
  fixture.export.mockRejectedValueOnce(new Error('Snapshot unavailable'))
  await expect(openLogsFolder()).rejects.toThrow('Snapshot unavailable')
  expect(fixture.open).not.toHaveBeenCalled()
})
