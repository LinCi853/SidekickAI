import { EventEmitter } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

const state = vi.hoisted(() => ({ settings: { downloadDir: 'E:/fixture/downloads', downloadBehavior: 'auto' }, dialog: vi.fn(), add: vi.fn(), update: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'E:/fixture/default-downloads' }, BrowserWindow: { getAllWindows: () => [] }, dialog: { showSaveDialog: state.dialog }, session: {} }))
vi.mock('../store/app-settings-store.js', () => ({ getAppSettings: () => state.settings, updateAppSettings: vi.fn() }))
vi.mock('../store/profile-store.js', () => ({ profileStore: { list: () => [] } }))
vi.mock('../store/browser-download-store.js', () => ({ browserDownloadStore: { add: state.add, update: state.update } }))
vi.mock('../security/session-permissions.js', () => ({ installProfilePermissions: vi.fn() }))
import { attachDownloadHandler } from './download-handler.js'

function fixture(filename: string) {
  const session = new EventEmitter(); attachDownloadHandler(session as unknown as Session, 'profile')
  const item = Object.assign(new EventEmitter(), { getFilename: () => filename, getURL: () => 'https://fixture.test/download', getTotalBytes: () => 3,
    getReceivedBytes: () => 3, setSavePath: vi.fn(), cancel: vi.fn() })
  return { session, item, start: () => (session.listeners('will-download')[0] as Function)({}, item) }
}
beforeEach(() => { vi.resetAllMocks(); state.settings = { downloadDir: 'E:/fixture/downloads', downloadBehavior: 'auto' } })

describe('main window downloads', () => {
  it.each(['../../outside.txt', '..\\..\\outside.txt', 'C:\\outside.txt', 'file.txt:payload', 'CON.txt', '...'])('keeps the server filename in the selected directory: %s', async filename => {
    const test = fixture(filename); await test.start()
    const target = test.item.setSavePath.mock.calls[0][0]
    expect(path.dirname(target)).toBe(path.resolve(state.settings.downloadDir))
    expect(path.basename(target)).not.toMatch(/[\\/:]/)
    expect(path.basename(target)).not.toMatch(/^(con|prn|nul|aux)(\.|$)/i)
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ savePath: target, filename: path.basename(target) }))
  })

  it('contains the proposed path and preserves an explicit save choice', async () => {
    state.settings.downloadBehavior = 'ask'; state.dialog.mockResolvedValue({ filePath: 'E:/chosen/result.txt', canceled: false })
    const test = fixture('../outside.txt'); await test.start()
    expect(path.dirname(state.dialog.mock.calls[0][0].defaultPath)).toBe(path.resolve(state.settings.downloadDir))
    expect(test.item.setSavePath).toHaveBeenCalledWith('E:/chosen/result.txt')
  })

  it('cancels when the user dismisses the save dialog', async () => {
    state.settings.downloadBehavior = 'ask'; state.dialog.mockResolvedValue({ canceled: true })
    const test = fixture('report.txt'); await test.start()
    expect(test.item.cancel).toHaveBeenCalledOnce(); expect(test.item.setSavePath).not.toHaveBeenCalled(); expect(state.add).not.toHaveBeenCalled()
  })
})
