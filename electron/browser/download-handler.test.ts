import { EventEmitter } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'

const state = vi.hoisted(() => ({
  settings: { downloadDir: 'E:/fixture/downloads', downloadBehavior: 'auto' } as {
    downloadDir: string
    downloadBehavior: 'ask' | 'auto'
  },
  sessions: new Map<string, EventEmitter>(),
  windows: new Map<object, object>(),
  ids: new Map<object, string>(),
  records: new Map<number, object>(),
  byProfile: new Map<string, object>(),
  profiles: new Map<string, { downloadSettings?: unknown }>(),
  showSaveDialog: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  serial: 0,
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'E:/fixture/system-downloads' },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (host: object) => state.windows.get(host),
  },
  dialog: { showSaveDialog: vi.fn() },
  session: { fromPartition: (partition: string) => state.sessions.get(partition) },
}))
vi.mock('crypto', () => ({ randomUUID: () => `download-${++state.serial}` }))
vi.mock('../store/app-settings-repository.js', () => ({
  getAppSettings: () => state.settings,
}))
vi.mock('../store/app-settings-store.js', () => ({
  updateAppSettings: vi.fn(),
}))
vi.mock('./profile-store.js', () => ({
  profileStore: {
    list: () => [],
    get: (id: string) => state.profiles.get(id) ?? null,
    update: vi.fn(),
  },
}))
vi.mock('./browser-download-store.js', () => ({
  browserDownloadStore: { add: state.add, update: state.update },
}))
vi.mock('../platform/security/session-permissions.js', () => ({
  installProfilePermissions: vi.fn(),
}))
vi.mock('./webview-registry.js', () => ({
  getRecordByWebContentsId: (id: number) => state.records.get(id),
}))
vi.mock('./save-dialog.js', () => ({
  showSaveDialog: state.showSaveDialog,
}))
vi.mock('../platform/window/window-state.js', () => ({
  windowState: { browserWindowsByProfile: state.byProfile },
}))
vi.mock('../platform/window/window-utils.js', () => ({
  findWindowIdByWin: (win: object) => state.ids.get(win),
}))

import { attachDownloadHandler, hasActiveDownloads } from './download-handler.js'

/** 下载项与 session 的测试替身类型 */
interface DownloadItemFixture extends EventEmitter {
  setSavePath: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  getFilename: () => string
  getURL: () => string
  getURLChain: () => string[]
  getTotalBytes: () => number
  getReceivedBytes: () => number
  getSavePath: () => string
}
interface SessionFixture extends EventEmitter {
  downloadURL: ReturnType<typeof vi.fn>
}

/** 记录本轮创建的下载项，用于在用例之间清空主进程的活动下载集合 */
const createdItems: DownloadItemFixture[] = []

function itemFixture(filename = 'file.txt'): DownloadItemFixture {
  const item: DownloadItemFixture = Object.assign(new EventEmitter(), {
    getFilename: () => filename,
    getURL: () => 'https://fixture.test/file',
    getURLChain: () => ['https://fixture.test/file'],
    getTotalBytes: () => 10,
    getReceivedBytes: () => 10,
    getSavePath: () => 'E:/chosen/file.txt',
    setSavePath: vi.fn(),
    cancel: vi.fn(),
  })
  createdItems.push(item)
  return item
}

function sessionFixture(profileId = 'profile'): SessionFixture {
  const session: SessionFixture = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    // 模拟用户选定路径后的重新下载：同一 URL 再次触发 will-download
    downloadURL: vi.fn(() => {
      const next = itemFixture()
      queueMicrotask(() =>
        session.emit('will-download', { preventDefault: vi.fn() }, next, undefined),
      )
      return Promise.resolve()
    }),
  })
  state.sessions.set(`persist:${profileId}`, session)
  return session
}

function windowFixture(id: string, guestId: number, profileId = 'profile') {
  const host = {}
  const win = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
  }
  state.windows.set(host, win)
  state.ids.set(win, id)
  state.records.set(guestId, { windowId: id, profileId })
  state.byProfile.set(profileId, win)
  const guest = {
    id: guestId,
    hostWebContents: host,
    isDestroyed: () => false,
    getURL: () => 'https://fixture.test/page',
    getType: () => 'webview',
    session: state.sessions.get(`persist:${profileId}`),
  } as unknown as WebContents
  return { win, guest }
}

/** 触发一次下载并等待监听内的异步处理结束 */
async function emitDownload(
  session: SessionFixture,
  item: DownloadItemFixture,
  guest?: WebContents,
) {
  const event = { preventDefault: vi.fn() }
  session.emit('will-download', event, item, guest)
  await vi.waitFor(() => expect(state.showSaveDialog).toHaveBeenCalled())
  await new Promise((resolve) => setImmediate(resolve))
  return event
}

beforeEach(() => {
  // 先让上一轮的下载项结束，避免它们的完成回调计入本轮断言
  for (const item of createdItems.splice(0)) item.emit('done', {}, 'cancelled')
  vi.resetAllMocks()
  state.settings = { downloadDir: 'E:/fixture/downloads', downloadBehavior: 'auto' }
  state.sessions.clear()
  state.windows.clear()
  state.ids.clear()
  state.records.clear()
  state.byProfile.clear()
  state.profiles.clear()
  state.serial = 0
  state.showSaveDialog.mockResolvedValue({
    action: 'save',
    filePath: 'E:/chosen/file.txt',
    remember: false,
  })
})

describe('single download listener per session', () => {
  it('keeps one will-download listener when the same session is attached twice', () => {
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    // 独立浏览器窗口创建时会再次挂载同一个 partition
    attachDownloadHandler(session as unknown as Session, 'profile')
    expect(session.listenerCount('will-download')).toBe(1)
  })

  it('opens exactly one save dialog for one save', async () => {
    state.settings.downloadBehavior = 'ask'
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture()
    await emitDownload(session, item, current.guest)
    expect(state.showSaveDialog).toHaveBeenCalledTimes(1)
  })

  it('opens exactly one save dialog for one ordinary download', async () => {
    state.settings.downloadBehavior = 'ask'
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture()
    await emitDownload(session, item, current.guest)
    expect(state.showSaveDialog).toHaveBeenCalledTimes(1)
  })
})

describe('download target selection', () => {
  it.each([
    '../../outside.txt',
    '..\\..\\outside.txt',
    'C:\\outside.txt',
    'file.txt:payload',
    'CON.txt',
    '...',
  ])('keeps the server filename inside the selected directory: %s', async (filename) => {
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture(filename)
    session.emit('will-download', { preventDefault: vi.fn() }, item)
    await vi.waitFor(() => expect(item.setSavePath).toHaveBeenCalled())
    const target = item.setSavePath.mock.calls[0][0]
    expect(path.dirname(target)).toBe(path.resolve(state.settings.downloadDir))
    expect(path.basename(target)).not.toMatch(/[\\/:]/)
    expect(path.basename(target)).not.toMatch(/^(con|prn|nul|aux)(\.|$)/i)
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: target, filename: path.basename(target) }),
    )
  })

  it('saves automatically into the configured directory without asking', async () => {
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture('report.txt')
    session.emit('will-download', { preventDefault: vi.fn() }, item)
    await vi.waitFor(() => expect(item.setSavePath).toHaveBeenCalled())
    expect(state.showSaveDialog).not.toHaveBeenCalled()
    expect(item.setSavePath).toHaveBeenCalledWith(
      path.join(path.resolve(state.settings.downloadDir), 'report.txt'),
    )
  })

  it('falls back to the system download directory when none is configured', async () => {
    state.settings.downloadDir = ''
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture('report.txt')
    session.emit('will-download', { preventDefault: vi.fn() }, item)
    await vi.waitFor(() => expect(item.setSavePath).toHaveBeenCalled())
    expect(path.dirname(item.setSavePath.mock.calls[0][0])).toBe(
      path.resolve('E:/fixture/system-downloads'),
    )
  })

  it('opens the save dialog in the configured directory', async () => {
    state.settings.downloadBehavior = 'ask'
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture('../outside.txt')
    await emitDownload(session, item, current.guest)
    const options = state.showSaveDialog.mock.calls[0][1]
    expect(path.resolve(options.directory)).toBe(path.resolve(state.settings.downloadDir))
    expect(options.fileName).not.toMatch(/[\\/:]/)
  })

  it('cancels the pending download and saves to the chosen path afterwards', async () => {
    state.settings.downloadBehavior = 'ask'
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture()
    const event = await emitDownload(session, item, current.guest)
    // 保存路径必须在 will-download 回调内同步设置，先取消本次下载再按选定路径重新下载
    expect(event.preventDefault).toHaveBeenCalled()
    expect(item.setSavePath).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(session.downloadURL).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
    const saved = createdItems[createdItems.length - 1]
    expect(saved.setSavePath).toHaveBeenCalledWith('E:/chosen/file.txt')
    expect(state.add).toHaveBeenCalledTimes(1)
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: 'E:/chosen/file.txt' }),
    )
  })

  it('does not download anything when the user cancels the save dialog', async () => {
    state.settings.downloadBehavior = 'ask'
    state.showSaveDialog.mockResolvedValue({ action: 'cancel', remember: false })
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture()
    await emitDownload(session, item, current.guest)
    expect(session.downloadURL).not.toHaveBeenCalled()
    expect(state.add).not.toHaveBeenCalled()
  })
})

describe('download ownership', () => {
  it('parents the save dialog to the initiating window', async () => {
    state.settings.downloadBehavior = 'ask'
    const current = windowFixture('current', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    await emitDownload(session, itemFixture(), current.guest)
    expect(state.showSaveDialog).toHaveBeenCalledWith(
      current.win,
      expect.objectContaining({ title: '另存为' }),
    )
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'current', profileId: 'profile' }),
    )
  })

  it('uses the initiating host when another same profile window is present', async () => {
    state.settings.downloadBehavior = 'ask'
    const first = windowFixture('first', 1)
    windowFixture('second', 2)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    await emitDownload(session, itemFixture(), first.guest)
    expect(state.showSaveDialog).toHaveBeenCalledWith(first.win, expect.anything())
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ windowId: 'first' }))
  })

  it('does not substitute another profile window or pass a destroyed parent', async () => {
    state.settings.downloadBehavior = 'ask'
    const old = windowFixture('old', 1)
    old.win.destroyed = true
    windowFixture('unrelated', 2, 'other')
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    await emitDownload(session, itemFixture(), old.guest)
    expect(state.showSaveDialog).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ title: '另存为' }),
    )
  })

  it('keeps one AI application asking while another account downloads normally', async () => {
    // profile 独立设置为“每次询问”，other 跟随主应用的“自动保存到目录”
    state.profiles.set('profile', {
      downloadSettings: { mode: 'custom', downloadBehavior: 'ask' },
    })
    const first = windowFixture('first', 1)
    const other = windowFixture('other', 2, 'other')
    const session = sessionFixture()
    const otherSession = sessionFixture('other')
    attachDownloadHandler(session as unknown as Session, 'profile')
    attachDownloadHandler(otherSession as unknown as Session, 'other')
    const ordinary = itemFixture()
    otherSession.emit('will-download', { preventDefault: vi.fn() }, ordinary, other.guest)
    await vi.waitFor(() => expect(ordinary.setSavePath).toHaveBeenCalled())
    expect(state.showSaveDialog).not.toHaveBeenCalled()
    expect(ordinary.setSavePath).toHaveBeenCalledWith(
      path.join(path.resolve(state.settings.downloadDir), 'file.txt'),
    )
    await emitDownload(session, itemFixture(), first.guest)
    expect(state.showSaveDialog).toHaveBeenCalledTimes(1)
    expect(state.showSaveDialog).toHaveBeenCalledWith(first.win, expect.anything())
  })

  it('retains item progress and completion after its initiating window closes', async () => {
    state.settings.downloadBehavior = 'ask'
    const first = windowFixture('first', 1)
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    await emitDownload(session, itemFixture(), first.guest)
    await vi.waitFor(() => expect(session.downloadURL).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
    const saved = createdItems[createdItems.length - 1]
    first.win.destroyed = true
    saved.emit('updated', {}, 'progressing')
    saved.emit('done', {}, 'completed')
    expect(saved.cancel).not.toHaveBeenCalled()
    expect(state.update).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ state: 'completed', receivedBytes: 10 }),
    )
  })
})

describe('active download tracking', () => {
  it('protects the save dialog until the user decides', async () => {
    state.settings.downloadBehavior = 'ask'
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    let resolveDialog!: (result: { action: string; remember: boolean }) => void
    state.showSaveDialog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve
        }),
    )
    session.emit('will-download', { preventDefault: vi.fn() }, itemFixture('report.txt'))
    await vi.waitFor(() => expect(state.showSaveDialog).toHaveBeenCalled())
    expect(hasActiveDownloads()).toBe(true)
    resolveDialog({ action: 'cancel', remember: false })
    await vi.waitFor(() => expect(hasActiveDownloads()).toBe(false))
  })

  it('keeps the transfer active until the download finishes', async () => {
    const session = sessionFixture()
    attachDownloadHandler(session as unknown as Session, 'profile')
    const item = itemFixture('report.txt')
    session.emit('will-download', { preventDefault: vi.fn() }, item)
    await vi.waitFor(() => expect(item.setSavePath).toHaveBeenCalled())
    expect(hasActiveDownloads()).toBe(true)
    item.emit('done', {}, 'interrupted')
    expect(hasActiveDownloads()).toBe(false)
  })
})
