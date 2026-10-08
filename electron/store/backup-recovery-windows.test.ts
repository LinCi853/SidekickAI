import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const test = vi.hoisted(() => ({ windows: [] as any[], focused: null as any, state: {} as any, createMain: vi.fn(), createChat: vi.fn(), createPanel: vi.fn(), showSettings: vi.fn(), browserState: null as any, createBrowser: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => test.windows, getFocusedWindow: () => test.focused }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } }))
vi.mock('../window-state.js', () => ({ windowState: test.state }))
vi.mock('../window-factory.js', () => ({ createMainWindow: test.createMain, createChatWindow: test.createChat, createAdvancedPanelWindow: test.createPanel, showHistoryWindow: vi.fn(), showPromptWindow: vi.fn(), showDataExportWindow: vi.fn(), showSettingsWindow: test.showSettings, showOnboardingWindow: vi.fn(), showAiAppEditorWindow: vi.fn(), createBrowserWindow: test.createBrowser, showHistoryDownloadWindow: vi.fn() }))
vi.mock('./browser-window-store.js', () => ({ browserWindowStore: { get: () => test.browserState } }))
import { captureBackupWindows, restoreBackupWindows } from './backup-recovery-windows.js'

function window(id: number, visible = true) {
  return Object.assign(new EventEmitter(), {
    id, isDestroyed: () => false, isVisible: () => visible, isMinimized: () => false, isMaximized: () => false, isFullScreen: () => false, isAlwaysOnTop: () => false,
    getNormalBounds: () => ({ x: 130, y: 170, width: 810, height: 620 }),
    webContents: { getURL: (): string => 'file:///app/index.html?windowId=main', isLoadingMainFrame: (): boolean => false },
    setBounds: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), setFullScreen: vi.fn(), setAlwaysOnTop: vi.fn(), minimize: vi.fn(), showInactive: vi.fn(), hide: vi.fn(), focus: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  test.windows = []
  test.focused = null
  Object.keys(test.state).forEach(key => delete test.state[key])
  Object.assign(test.state, { detachedWindows: new Map(), aiAppEditorWindows: new Map(), browserWindowsByProfile: new Map() })
  test.browserState = null
})

describe('backup window recovery', () => {
  it('reuses the main window and restores visible geometry and final focus', async () => {
    const main = window(1)
    const settings = window(2)
    test.state.mainWindow = main
    test.state.settingsWindow = settings
    test.state.historyWindow = window(3, false)
    test.windows = [main, settings, test.state.historyWindow]
    test.focused = main
    const saved = captureBackupWindows() as any
    expect(saved.windows).toHaveLength(2)
    saved.windows[0].maximized = true
    await restoreBackupWindows(saved)
    expect(test.createMain).not.toHaveBeenCalled()
    expect(test.showSettings).toHaveBeenCalledOnce()
    expect(main.setBounds).toHaveBeenCalledWith({ x: 130, y: 170, width: 810, height: 620 })
    expect(main.maximize).toHaveBeenCalledOnce()
    expect(main.focus).toHaveBeenCalledOnce()
    expect(settings.focus).not.toHaveBeenCalled()
  })

  it('keeps a hidden main window hidden and skips unknown windows without replaying URLs', async () => {
    const main = window(1, false)
    test.state.mainWindow = main
    test.windows = [main, window(99)]
    const saved = captureBackupWindows() as any
    expect(saved.unsupported).toEqual([99])
    expect(saved.windows).toHaveLength(1)
    await expect(restoreBackupWindows(saved)).rejects.toThrow('Some backup windows could not be restored')
    expect(main.hide).toHaveBeenCalledOnce()
  })

  it('reopens browser windows with their saved identity and tabs through the browser factory', async () => {
    const browser = window(7)
    test.windows = [browser]
    test.state.detachedWindows.set('browser-1', browser)
    test.browserState = { windowId: 'browser-1', profileId: 'profile-1', tabs: [{ id: 'tab-1' }] }
    const saved = captureBackupWindows()
    test.state.detachedWindows.clear()
    test.createBrowser.mockReturnValue(browser)
    await restoreBackupWindows(saved)
    expect(test.createBrowser).toHaveBeenCalledWith('browser-1', 'profile-1')
    expect(test.browserState.tabs).toEqual([{ id: 'tab-1' }])
  })

  it('does not reopen a browser whose stored profile identity changed', async () => {
    const browser = window(7)
    test.windows = [browser]
    test.state.detachedWindows.set('browser-1', browser)
    test.browserState = { profileId: 'profile-1' }
    const saved = captureBackupWindows()
    test.state.detachedWindows.clear()
    test.browserState = { profileId: 'profile-2' }
    await expect(restoreBackupWindows(saved)).rejects.toThrow('Some backup windows could not be restored')
    expect(test.createBrowser).not.toHaveBeenCalled()
  })

  it.each([
    ['chat', 'provider-2', { initialTab: 'chat', providerId: 'provider-2' }],
    ['notes', 'stale-provider', { initialTab: 'notes' }],
  ])('restores the current panel route %s through factory options', async (tab, provider, options) => {
    const panel = window(9)
    panel.webContents.getURL = () => 'file:///app/index.html?windowId=advanced-panel&tab=' + tab + '&provider=' + provider
    test.state.advancedPanelWindow = panel
    test.windows = [panel]
    test.createPanel.mockReturnValue(panel)
    await restoreBackupWindows(captureBackupWindows())
    expect(test.createPanel).toHaveBeenCalledWith(options)
  })

  it('rejects malformed state before creating windows', async () => {
    await expect(restoreBackupWindows({ version: 1, windows: [{ target: { kind: 'mainWindow' }, bounds: { width: NaN } }] })).rejects.toThrow('Invalid backup window recovery state')
    expect(test.createMain).not.toHaveBeenCalled()
  })

  it('restores remaining windows when one factory fails, then reports the failure', async () => {
    const main = window(1)
    const settings = window(2)
    test.state.mainWindow = main
    test.state.settingsWindow = settings
    test.windows = [settings, main]
    test.showSettings.mockImplementationOnce(() => { throw new Error('unavailable') })
    await expect(restoreBackupWindows(captureBackupWindows())).rejects.toThrow('Some backup windows could not be restored')
    expect(main.setBounds).toHaveBeenCalledOnce()
  })

  it('waits for a new renderer before applying geometry and focus', async () => {
    const chat = window(3, false)
    chat.webContents.isLoadingMainFrame = () => true
    test.state.detachedWindows.set('chat', chat)
    test.windows = [chat]
    const saved = { version: 1, windows: [{ target: { kind: 'chat' }, bounds: chat.getNormalBounds(), maximized: false, fullscreen: false, minimized: false, pinned: false, visible: true, focused: true }] }
    test.createChat.mockReturnValue(chat)
    const pending = restoreBackupWindows(saved)
    await Promise.resolve()
    expect(chat.setBounds).not.toHaveBeenCalled()
    chat.emit('ready-to-show')
    await pending
    expect(chat.focus).toHaveBeenCalledOnce()
  })
})
