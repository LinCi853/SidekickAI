import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => {
  const send = vi.fn()
  return {
    onHandlers: new Map<string, (...args: any[]) => unknown>(),
    handleHandlers: new Map<string, (...args: any[]) => unknown>(),
    send,
    save: vi.fn(),
    getOrDefault: vi.fn(() => ({
      detachedProfiles: ['profile-1'],
      tabs: [{ id: 'tab-1', profileId: 'profile-1', detachedWindowId: 'browser-1' }],
    })),
    fromWebContents: vi.fn((): any => null),
    isBackgroundClose: vi.fn((win: unknown): boolean => false),
    mainWindow: {
      isDestroyed: () => false,
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send },
    },
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: any[]) => unknown) =>
      runtime.onHandlers.set(channel, handler),
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      runtime.handleHandlers.set(channel, handler),
  },
  BrowserWindow: { fromWebContents: runtime.fromWebContents },
}))
vi.mock('../store/window-store.js', () => ({
  windowStore: { getOrDefault: runtime.getOrDefault, save: runtime.save },
}))
vi.mock('./profile-store.js', () => ({ profileStore: { get: () => ({ name: 'App' }) } }))
vi.mock('../platform/window/window-state.js', () => ({
  windowState: { mainWindow: runtime.mainWindow },
}))
vi.mock('./detach-profile.js', () => ({ detachProfileToBrowserWindow: vi.fn() }))
vi.mock('../modules/registry.js', () => ({ isModuleEnabled: () => true }))
vi.mock('../platform/window/window-retirement.js', () => ({
  isBackgroundClose: runtime.isBackgroundClose,
}))
vi.mock('../platform/security/trusted-renderer.js', () => ({ assertTrustedRenderer: vi.fn() }))

import { registerTabIpc } from './tab-ipc.js'
import { IPC_CHANNELS } from '../shared/types.js'

function reset() {
  runtime.onHandlers.clear()
  runtime.handleHandlers.clear()
  runtime.send.mockClear()
  runtime.save.mockClear()
  runtime.fromWebContents.mockReturnValue(null)
  runtime.isBackgroundClose.mockReturnValue(false)
  runtime.mainWindow.isMinimized.mockReturnValue(false)
  runtime.mainWindow.isVisible.mockReturnValue(true)
  runtime.mainWindow.restore.mockClear()
  runtime.mainWindow.show.mockClear()
  runtime.mainWindow.focus.mockClear()
}

function invokeMigrateBack(sender: unknown) {
  const handler = runtime.onHandlers.get(IPC_CHANNELS.BROWSER_TAB_MIGRATE_BACK)!
  handler(
    { sender },
    { profileId: 'profile-1', url: 'https://example.test/', title: 'Example', finalUrls: [] },
  )
}

function expectNoForegroundSteal() {
  expect(runtime.mainWindow.restore).not.toHaveBeenCalled()
  expect(runtime.mainWindow.show).not.toHaveBeenCalled()
  expect(runtime.mainWindow.focus).not.toHaveBeenCalled()
}

function expectForegroundSteal() {
  expect(runtime.mainWindow.focus).toHaveBeenCalled()
}

describe('BROWSER_TAB_MIGRATE_BACK foreground guard', () => {
  beforeEach(() => {
    reset()
    registerTabIpc({
      windowManager: {} as never,
      getSenderWindow: () => null,
      findWindowIdByWin: () => null,
      createBrowserWindow: () => null as never,
    })
  })

  it('migrates tab state without stealing focus when the sender window is background-closed', () => {
    const senderWin = {}
    runtime.fromWebContents.mockReturnValue(senderWin)
    runtime.isBackgroundClose.mockImplementation((win: unknown) => win === senderWin)

    invokeMigrateBack({})

    expect(runtime.save).toHaveBeenCalled()
    expect(runtime.send).toHaveBeenCalled()
    expectNoForegroundSteal()
  })

  it('steals focus for an ordinary close whose sender window is still alive', () => {
    runtime.fromWebContents.mockReturnValue({})

    invokeMigrateBack({})

    expect(runtime.save).toHaveBeenCalled()
    expectForegroundSteal()
  })

  it('skips focus when the sender window is already destroyed, leaving it to the closed fallback', () => {
    runtime.fromWebContents.mockReturnValue(null)

    invokeMigrateBack({})

    expect(runtime.save).toHaveBeenCalled()
    expect(runtime.send).toHaveBeenCalled()
    expectNoForegroundSteal()
  })

  it('still restores a minimized main window on ordinary close', () => {
    runtime.fromWebContents.mockReturnValue({})
    runtime.mainWindow.isMinimized.mockReturnValue(true)
    runtime.mainWindow.isVisible.mockReturnValue(false)

    invokeMigrateBack({})

    expect(runtime.mainWindow.restore).toHaveBeenCalled()
    expect(runtime.mainWindow.show).toHaveBeenCalled()
    expectForegroundSteal()
  })
})
