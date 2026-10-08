import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./browser-window.ts', import.meta.url), 'utf8')
const callback = source.match(/win\.on\('closed', \(\) => \{([\s\S]*?)\n  \}\)/)?.[1]
if (!callback) throw new Error('Browser close callback was not found')

function closeBrowser(appQuitting: boolean) {
  const win = { webContents: { id: 5 } }
  const main = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, focus: vi.fn(), webContents: { send: vi.fn() } }
  const state = { mainWindow: main, browserWindowsByProfile: new Map([['profile-1', win]]) }
  const saved = { profileId: 'profile-1', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', parentTabId: 'parent-1', url: 'https://example.test/', title: 'Example' }] }
  const browserStore = { get: vi.fn(() => saved), delete: vi.fn() }
  const mainStore = { get: () => ({ detachedProfiles: ['profile-1'], tabs: [{ profileId: 'profile-1', detachedWindowId: 'browser-1' }] }), save: vi.fn() }
  const close = new Function('win', 'exitCloudPc', 'windowState', 'profileId', 'windowId', 'browserWindowStore', 'windowStore', 'MAIN_WINDOW_ID', 'IPC_CHANNELS', 'appQuitting', callback!)
  close(win, vi.fn(), state, 'profile-1', 'browser-1', browserStore, mainStore, 'main', { BROWSER_TAB_MIGRATE_BACK: 'migrate' }, appQuitting)
  return { state, browserStore, mainStore, main }
}

describe('browser window exit persistence', () => {
  it('retains saved browser tabs and detached ownership during application exit', () => {
    const result = closeBrowser(true)
    expect(result.state.browserWindowsByProfile.size).toBe(0)
    expect(result.browserStore.delete).not.toHaveBeenCalled()
    expect(result.mainStore.save).not.toHaveBeenCalled()
    expect(result.main.webContents.send).not.toHaveBeenCalled()
    expect(result.main.focus).not.toHaveBeenCalled()
  })

  it('still migrates the parent tab and removes browser state for an ordinary close', () => {
    const result = closeBrowser(false)
    expect(result.state.browserWindowsByProfile.size).toBe(0)
    expect(result.browserStore.delete).toHaveBeenCalledWith('browser-1')
    expect(result.mainStore.save).toHaveBeenCalledWith('main', expect.objectContaining({ detachedProfiles: [], tabs: [{ profileId: 'profile-1', detachedWindowId: null }] }))
    expect(result.main.webContents.send).toHaveBeenCalledWith('migrate', expect.objectContaining({ profileId: 'profile-1' }))
  })
})
