import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ portable: true, login: vi.fn() }))
vi.mock('electron', () => ({ app: { setLoginItemSettings: runtime.login } }))
vi.mock('./store-paths.js', () => ({ isPortableMode: () => runtime.portable, getStoreCwd: vi.fn() }))
vi.mock('./module-state-store.js', () => ({ getAppSettingsTable: vi.fn() }))
vi.mock('../shared/broadcast.js', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../hotkey/manager.js', () => ({ getHotkeyManagerInstance: vi.fn() }))
import { applyAutoLaunchSetting, updateAppSettings } from './app-settings-store'

beforeEach(() => { runtime.portable = true; runtime.login.mockReset() })

describe('portable system integration', () => {
  it('does not touch the login registry during normal startup', () => {
    expect(applyAutoLaunchSetting(false, false)).toBe(true)
    expect(runtime.login).not.toHaveBeenCalled()
  })
  it('does not register autostart from imported settings', () => {
    expect(applyAutoLaunchSetting(true, true)).toBe(false)
    expect(runtime.login).not.toHaveBeenCalled()
  })
  it('rejects autostart before persisting an unsupported setting', () => {
    expect(() => updateAppSettings({ autoLaunch: true })).toThrow('绿色便携版')
    expect(runtime.login).not.toHaveBeenCalled()
  })
  it('retains installed autostart behavior', () => {
    runtime.portable = false
    expect(applyAutoLaunchSetting(true, true)).toBe(true)
    expect(runtime.login).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] })
  })
})
