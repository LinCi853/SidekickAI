import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  values: new Map<string, unknown>(),
  callbacks: new Map<string, () => void>(),
  defaults: {} as Record<string, unknown>,
  modules: new Set(['prompt-library', 'notes']),
  observers: [] as Array<() => void>,
  prompt: undefined as any,
  showAssets: vi.fn(), showMain: vi.fn(), hideMain: vi.fn(), broadcast: vi.fn(), storeWrite: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler) },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => { state.callbacks.set(accelerator, callback); return true },
    unregister: (accelerator: string) => state.callbacks.delete(accelerator),
    unregisterAll: () => state.callbacks.clear(), isRegistered: (accelerator: string) => state.callbacks.has(accelerator),
  },
}))
vi.mock('../store/module-state-store.js', () => ({ createSqliteJsonStore: ({ defaults }: { defaults: Record<string, unknown> }) => {
  state.defaults = defaults
  return { get: (key: string) => state.values.has(key) ? state.values.get(key) : defaults[key], set: (key: string, value: unknown) => { state.values.set(key, value); state.storeWrite(key, value) } }
} }))
vi.mock('../hotkey/uiohook.js', () => ({
  UiohookKey: { Space: 32, Q: 81, A: 65, V: 86, LeftAlt: 56, RightAlt: 584, LeftControl: 29, RightControl: 585, LeftShift: 42, RightShift: 54, LeftMeta: 3675, RightMeta: 3676 },
  EventType: { EVENT_KEY_PRESSED: 7, EVENT_KEY_RELEASED: 8 }, uIOhook: { on: vi.fn(), start: vi.fn(), stop: vi.fn() },
  getUiohookAvailability: () => ({ available: false, error: 'Isolated fixture' }),
}))
vi.mock('../utils/permission-manager.js', () => ({ checkAccessibilityPermission: () => true }))
vi.mock('../utils/browser-hotkey-fallback.js', () => ({ dispatchBrowserHotkeyFallback: vi.fn() }))
vi.mock('../modules/registry.js', () => ({
  isModuleEnabled: (id: string) => state.modules.has(id), listModuleInfos: () => [],
  observeModuleState: (callback: () => void) => { state.observers.push(callback); return () => {} },
}))
vi.mock('../modules/wiring/voice.js', () => ({ syncVoiceHotkeyRegistration: vi.fn() }))
vi.mock('../modules/wiring/hotkey-sync.js', () => ({
  setAdvancedPanelAvailability: vi.fn(), setAdvancedPanelCallback: vi.fn(), setBrowserAvailability: vi.fn(),
  syncAdvancedPanelHotkey: vi.fn(), syncBrowserProfileShortcuts: vi.fn(),
}))
vi.mock('../window-factory/main-window.js', () => ({ resetMainWindowToDefault: vi.fn() }))
vi.mock('../store/app-settings-store.js', () => ({ getAppSettings: () => ({ altSpaceResetThreshold: 3 }) }))
vi.mock('../utils/focus-manager.js', () => ({ show: state.showMain, hide: state.hideMain }))
vi.mock('../window-factory/popup-windows.js', () => ({ showPromptWindow: state.showAssets }))
vi.mock('../assets/settings.js', () => ({ getAssetSettings: () => ({ localShortcuts: { search: 'Ctrl+F' } }) }))
vi.mock('../window-state.js', () => ({ windowState: { get promptWindow() { return state.prompt } } }))
vi.mock('../shared/broadcast.js', () => ({ broadcastToAllWindows: state.broadcast }))
import { HotkeyManager } from '../hotkey/manager'
import { registerHotkeyIpc } from './hotkey-ipc'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels'

let manager: HotkeyManager
const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const invoke = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!({}, ...args)
async function start() {
  registerHotkeyIpc({ hotkeyManager: manager, getMainWindow: () => ({ isVisible: () => true, isMinimized: () => false, isFocused: () => true, isDestroyed: () => false, webContents: { send: vi.fn() } }) as any,
    toggleAdvancedPanelWindow: vi.fn(), startBackgroundVoice: vi.fn(), stopBackgroundVoice: vi.fn(), toggleVoiceRecording: vi.fn() })
  await settle()
}
beforeEach(() => {
  vi.stubEnv('SIDEKICK_TEST_SESSION', `assets-shortcut-${process.pid}-${Math.random()}`)
  vi.clearAllMocks(); state.values.clear(); state.callbacks.clear(); state.handlers.clear(); state.observers = []; state.prompt = undefined
  state.modules = new Set(['prompt-library', 'notes'])
  manager = new HotkeyManager()
})
afterEach(() => { manager.unregisterAll(); vi.unstubAllEnvs(); vi.useRealTimers() })
describe('AI asset global shortcut ownership', () => {
  it('keeps fresh AI assets unbound while registering the main window shortcut', async () => {
    await start()
    expect(manager.getAllHotkeys().find(value => value.action === 'toggleAiAssets')).toMatchObject({ accelerator: '', enabled: false })
    expect(state.callbacks.has('Alt+Space')).toBe(true)
    expect(state.showAssets).not.toHaveBeenCalled()
  })
  it('rejects duplicate combinations in both directions before touching current registrations', async () => {
    await start()
    await expect(invoke(ipc.HOTKEY_SET, 'toggleAiAssets', 'Alt+Space')).rejects.toThrow()
    await invoke(ipc.HOTKEY_SET, 'toggleAiAssets', 'Ctrl+Alt+A')
    const main = state.callbacks.get('Alt+Space')
    const assets = state.callbacks.get('Ctrl+Alt+A')
    state.storeWrite.mockClear()
    await expect(invoke(ipc.HOTKEY_SET, 'toggleMainWindow', 'Control+Alt+A')).rejects.toThrow()
    expect(state.callbacks.get('Alt+Space')).toBe(main)
    expect(state.callbacks.get('Ctrl+Alt+A')).toBe(assets)
    expect(state.storeWrite).not.toHaveBeenCalled()
  })
  it('reports a legacy collision on AI assets and keeps the main shortcut after disabling or changing assets', async () => {
    state.values.set('hotkey.toggleAiAssets', 'Alt+Space'); state.values.set('hotkey.enabled.toggleAiAssets', true)
    await start()
    const main = state.callbacks.get('Alt+Space')
    expect(manager.getAllHotkeys().find(value => value.action === 'toggleAiAssets')).toMatchObject({ registration: 'conflict' })
    expect(manager.getAllHotkeys().find(value => value.action === 'toggleMainWindow')).toMatchObject({ registration: 'registered' })
    await invoke(ipc.HOTKEY_SET_ENABLED, 'toggleAiAssets', false)
    expect(state.callbacks.get('Alt+Space')).toBe(main)
    await invoke(ipc.HOTKEY_SET, 'toggleAiAssets', 'Ctrl+Alt+A')
    expect(state.callbacks.get('Alt+Space')).toBe(main)
    expect(manager.getAllHotkeys().find(value => value.action === 'toggleAiAssets')).toMatchObject({ accelerator: 'Ctrl+Alt+A', enabled: true, registration: 'registered' })
  })
  it('refuses enabling a legacy collision without changing its stored choice', async () => {
    state.values.set('hotkey.toggleAiAssets', 'Alt+Space'); state.values.set('hotkey.enabled.toggleAiAssets', false)
    await start()
    const main = state.callbacks.get('Alt+Space'); state.storeWrite.mockClear()
    await expect(invoke(ipc.HOTKEY_SET_ENABLED, 'toggleAiAssets', true)).rejects.toThrow()
    expect(manager.getEnabled('toggleAiAssets')).toBe(false)
    expect(state.callbacks.get('Alt+Space')).toBe(main)
    expect(state.storeWrite).not.toHaveBeenCalled()
  })
  it('registers enabled AI assets after the main shortcut removes a legacy collision', async () => {
    state.values.set('hotkey.toggleAiAssets', 'Alt+Space'); state.values.set('hotkey.enabled.toggleAiAssets', true)
    await start()
    await invoke(ipc.HOTKEY_SET, 'toggleMainWindow', 'Ctrl+Alt+M'); await settle()
    expect(state.callbacks.has('Alt+Space')).toBe(true)
    expect(state.callbacks.has('Ctrl+Alt+M')).toBe(true)
    state.callbacks.get('Alt+Space')!()
    expect(state.showAssets).toHaveBeenCalledTimes(1)
    state.callbacks.get('Ctrl+Alt+M')!()
    expect(state.hideMain).toHaveBeenCalledTimes(1)
  })
  it('retains the main callback when a collided asset module is disabled', async () => {
    state.values.set('hotkey.toggleAiAssets', 'Alt+Space'); state.values.set('hotkey.enabled.toggleAiAssets', true)
    await start()
    const main = state.callbacks.get('Alt+Space')
    state.modules.delete('prompt-library'); state.observers.forEach(observer => observer()); await settle()
    expect(state.callbacks.get('Alt+Space')).toBe(main)
  })
  it('dispatches AI assets to its own window without changing main visibility', async () => {
    await start(); await invoke(ipc.HOTKEY_SET, 'toggleAiAssets', 'Ctrl+Alt+A')
    state.callbacks.get('Ctrl+Alt+A')!()
    expect(state.showAssets).toHaveBeenCalledTimes(1)
    expect(state.hideMain).not.toHaveBeenCalled(); expect(state.showMain).not.toHaveBeenCalled()
    state.prompt = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, close: vi.fn() }
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 500)
    state.callbacks.get('Ctrl+Alt+A')!()
    vi.useRealTimers()
    expect(state.prompt.close).toHaveBeenCalledTimes(1)
    expect(state.hideMain).not.toHaveBeenCalled()
  })
})
