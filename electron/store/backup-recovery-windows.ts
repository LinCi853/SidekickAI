import { BrowserWindow, screen, type Rectangle } from 'electron'
import { windowState } from '../window-state.js'
import { createMainWindow, createChatWindow, createAdvancedPanelWindow, showHistoryWindow, showPromptWindow, showDataExportWindow, showSettingsWindow, showOnboardingWindow, showAiAppEditorWindow } from '../window-factory.js'
import { createBrowserWindow, showHistoryDownloadWindow } from '../window-factory.js'
import { browserWindowStore } from './browser-window-store.js'

type EditorOptions = { platformId?: string; profileId?: string; mode?: 'edit' | 'create' }
type Target = { kind: string; id?: string; editor?: EditorOptions; profileId?: string; panel?: { initialTab: string; providerId?: string } }
type SavedWindow = { target: Target; bounds: Rectangle; maximized: boolean; fullscreen: boolean; minimized: boolean; pinned: boolean; visible: boolean; focused: boolean }
const singletonKeys = ['mainWindow', 'historyWindow', 'promptWindow', 'advancedPanelWindow', 'onboardingWindow', 'dataExportWindow', 'settingsWindow', 'historyDownloadWindow'] as const

function targetFor(window: BrowserWindow): Target | null {
  if (window === windowState.advancedPanelWindow) {
    const params = new URL(window.webContents.getURL()).searchParams
    const initialTab = params.get('tab') ?? 'chat'
    const providerId = initialTab === 'chat' ? params.get('provider') : null
    return { kind: 'advancedPanelWindow', panel: { initialTab, ...(providerId ? { providerId } : {}) } }
  }
  for (const key of singletonKeys) if (windowState[key] === window) return { kind: key }
  if (windowState.detachedWindows.get('chat') === window) return { kind: 'chat' }
  for (const [id, candidate] of windowState.detachedWindows) {
    if (candidate !== window) continue
    const saved = browserWindowStore.get(id)
    if (saved) return { kind: 'browser', id, profileId: saved.profileId }
  }
  for (const candidate of windowState.aiAppEditorWindows.values()) {
    if (candidate !== window) continue
    const windowId = new URL(window.webContents.getURL()).searchParams.get('windowId') ?? ''
    if (!windowId.startsWith('ai-app-editor-')) return null
    const parsed = JSON.parse(Buffer.from(windowId.slice('ai-app-editor-'.length), 'base64').toString('utf8'))
    if (!validEditor(parsed)) return null
    return { kind: 'editor', editor: parsed }
  }
  return null
}

function validEditor(value: unknown): value is EditorOptions {
  if (!value || typeof value !== 'object') return false
  const editor = value as EditorOptions
  return (editor.mode === undefined || editor.mode === 'edit' || editor.mode === 'create') &&
    ['platformId', 'profileId'].every(key => editor[key as keyof EditorOptions] === undefined || typeof editor[key as keyof EditorOptions] === 'string')
}

export function captureBackupWindows(): unknown {
  const focused = BrowserWindow.getFocusedWindow() ?? windowState.lastFocusedWin
  const windows: SavedWindow[] = []
  const unsupported: number[] = []
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || (!window.isVisible() && !window.isMinimized() && window !== windowState.mainWindow)) continue
    const target = targetFor(window)
    if (!target) { unsupported.push(window.id); continue }
    windows.push({ target, bounds: window.getNormalBounds(), maximized: window.isMaximized(), fullscreen: window.isFullScreen(), minimized: window.isMinimized(), pinned: window.isAlwaysOnTop(), visible: window.isVisible(), focused: window === focused })
  }
  return { version: 1, windows, unsupported }
}

async function openTarget(target: Target): Promise<BrowserWindow | null> {
  switch (target.kind) {
    case 'mainWindow':
      if (!windowState.mainWindow || windowState.mainWindow.isDestroyed()) createMainWindow()
      return windowState.mainWindow
    case 'chat': return createChatWindow()
    case 'advancedPanelWindow': {
      if (target.panel && (typeof target.panel.initialTab !== 'string' || (target.panel.providerId !== undefined && typeof target.panel.providerId !== 'string'))) throw new Error('Invalid panel recovery target')
      return createAdvancedPanelWindow(target.panel)
    }
    case 'historyWindow': showHistoryWindow(); return windowState.historyWindow
    case 'promptWindow': showPromptWindow(); return windowState.promptWindow
    case 'dataExportWindow': showDataExportWindow(); return windowState.dataExportWindow
    case 'settingsWindow': showSettingsWindow(); return windowState.settingsWindow
    case 'onboardingWindow': showOnboardingWindow(); return windowState.onboardingWindow
    case 'editor': {
      if (!validEditor(target.editor)) throw new Error('Invalid editor recovery target')
      showAiAppEditorWindow(target.editor)
      const key = target.editor.mode === 'create' ? 'create' : target.editor.profileId ?? target.editor.platformId ?? 'default'
      return windowState.aiAppEditorWindows.get(key) ?? null
    }
    case 'historyDownloadWindow': showHistoryDownloadWindow(); return windowState.historyDownloadWindow
    case 'browser': {
      if (typeof target.id !== 'string' || typeof target.profileId !== 'string') throw new Error('Invalid browser recovery target')
      const existing = windowState.detachedWindows.get(target.id)
      if (existing && !existing.isDestroyed()) return existing
      const saved = browserWindowStore.get(target.id)
      if (!saved || saved.profileId !== target.profileId) throw new Error('The saved browser window is unavailable')
      return createBrowserWindow(target.id, target.profileId)
    }
    default: throw new Error('Unsupported backup window target')
  }
}

function waitUntilShown(window: BrowserWindow): Promise<void> {
  if (window.isVisible() || !window.webContents.isLoadingMainFrame()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      window.removeListener('ready-to-show', ready)
      window.removeListener('closed', closed)
      if (error) reject(error); else resolve()
    }
    const ready = () => finish()
    const closed = () => finish(new Error('Window closed before recovery completed'))
    const timer = setTimeout(() => finish(new Error('Window recovery readiness timed out')), 15000)
    window.once('ready-to-show', ready)
    window.once('closed', closed)
  })
}

function validWindow(value: unknown): value is SavedWindow {
  if (!value || typeof value !== 'object') return false
  const saved = value as SavedWindow
  return !!saved.target && typeof saved.target.kind === 'string' && !!saved.bounds &&
    ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(saved.bounds[key as keyof Rectangle])) && saved.bounds.width > 0 && saved.bounds.height > 0 &&
    ['maximized', 'fullscreen', 'minimized', 'pinned', 'visible', 'focused'].every(key => typeof saved[key as keyof SavedWindow] === 'boolean')
}

function applyGeometry(window: BrowserWindow, saved: SavedWindow): void {
  const area = screen.getDisplayMatching(saved.bounds).workArea
  const bounds = { ...saved.bounds, x: Math.max(area.x, Math.min(saved.bounds.x, area.x + area.width - 80)), y: Math.max(area.y, Math.min(saved.bounds.y, area.y + area.height - 40)) }
  if (window.isFullScreen()) window.setFullScreen(false)
  if (window.isMaximized()) window.unmaximize()
  window.setBounds(bounds)
  if (saved.maximized) window.maximize()
  if (saved.fullscreen) window.setFullScreen(true)
  window.setAlwaysOnTop(saved.pinned)
  if (saved.minimized) window.minimize()
  else if (saved.visible) window.showInactive()
  else window.hide()
}

export async function restoreBackupWindows(state: unknown): Promise<void> {
  if (!state || typeof state !== 'object') throw new Error('Invalid backup window recovery state')
  const saved = state as { version?: unknown; windows?: unknown; unsupported?: unknown }
  if (saved.version !== 1 || !Array.isArray(saved.windows) || saved.windows.length > 256 || !saved.windows.every(validWindow)) throw new Error('Invalid backup window recovery state')
  let focused: BrowserWindow | null = null
  const errors: unknown[] = []
  if (Array.isArray(saved.unsupported) && saved.unsupported.length) errors.push(new Error('Some temporary windows must be reopened manually'))
  for (const item of saved.windows) {
    try {
      const window = await openTarget(item.target)
      if (!window || window.isDestroyed()) throw new Error('The requested window is unavailable')
      await waitUntilShown(window)
      applyGeometry(window, item)
      if (item.focused && item.visible && !item.minimized) focused = window
    } catch (error) { errors.push(error) }
  }
  if (focused && !focused.isDestroyed()) focused.focus()
  if (errors.length) throw new AggregateError(errors, 'Some backup windows could not be restored')
}
