import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateApplicationWindow, isApplicationWindowLoading } from './application-activation.js'

function windowFixture() {
  return { isDestroyed: vi.fn(() => false), isVisible: vi.fn(() => true), webContents: { isDestroyed: vi.fn(() => false), isLoadingMainFrame: vi.fn(() => false), executeJavaScript: vi.fn(async () => true) } } as unknown as BrowserWindow
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('responsive main application activation', () => {
  it('lets admission await a loading window before judging renderer health', async () => {
    const current = windowFixture()
    vi.mocked(current.webContents.isLoadingMainFrame).mockReturnValue(true)
    expect(isApplicationWindowLoading(current)).toBe(true)
    expect(await activateApplicationWindow({ current: () => current, create: vi.fn(), show: vi.fn() })).toBe(false)
    expect(current.webContents.executeJavaScript).not.toHaveBeenCalled()
    vi.mocked(current.webContents.isLoadingMainFrame).mockReturnValue(false)
    expect(isApplicationWindowLoading(current)).toBe(false)
    expect(await activateApplicationWindow({ current: () => current, create: vi.fn(), show: vi.fn() })).toBe(true)
  })
  it('recreates a retired main window instead of activating a background host', async () => {
    let current: BrowserWindow | null = null
    const create = vi.fn(() => { current = windowFixture() })
    const show = vi.fn()
    expect(await activateApplicationWindow({ current: () => current, create, show })).toBe(true)
    expect(create).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledWith(current)
  })

  it('accepts a visible responsive window even if Windows blocks foreground focus', async () => {
    const current = windowFixture()
    expect(await activateApplicationWindow({ current: () => current, create: vi.fn(), show: async () => 'blocked' })).toBe(true)
  })

  it('reports a hung renderer for admission recovery without an error dialog', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const current = windowFixture()
    vi.mocked(current.webContents.executeJavaScript).mockImplementation(() => new Promise(() => {}))
    const show = vi.fn()
    const pending = activateApplicationWindow({ current: () => current, create: vi.fn(), show })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('does not acknowledge a destroyed or still-hidden target as opened', async () => {
    const current = windowFixture()
    vi.mocked(current.isVisible).mockReturnValue(false)
    expect(await activateApplicationWindow({ current: () => current, create: vi.fn(), show: vi.fn() })).toBe(false)
  })
})
