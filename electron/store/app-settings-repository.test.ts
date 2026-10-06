import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAppSettings } from './app-settings-defaults.js'

const data = vi.hoisted(() => ({ raw: null as string | null | undefined, fail: false }))
vi.mock('./module-state-store.js', () => ({
  getAppSettingsTable: () => ({
    get: () => data.raw,
    set: (_key: string, raw: string) => {
      if (data.fail) throw new Error('Storage unavailable')
      data.raw = raw
    },
  }),
}))
vi.mock('./store-paths.js', () => ({ isPortableMode: () => false }))

import { readSettingsRaw, resetSettingsCacheForTest, validateAppSettingsPatch, writeSettingsRaw } from './app-settings-repository.js'

describe('Application settings persistence', () => {
  beforeEach(() => {
    data.raw = null
    data.fail = false
    resetSettingsCacheForTest()
  })

  it('loads valid old preferences while defaulting invalid fields without rewriting stored bytes', () => {
    data.raw = JSON.stringify({ proxyMode: 'broken', enterToSend: false, notesSidebarWidth: -2, hiddenPlatforms: [42] })
    const original = data.raw
    const settings = readSettingsRaw()
    expect(settings.enterToSend).toBe(false)
    expect(settings.proxyMode).toBe('system')
    expect(settings.notesSidebarWidth).toBe(160)
    expect(settings.hiddenPlatforms).toEqual([])
    expect(settings.autoUpdate).toBe(true)
    expect(data.raw).toBe(original)
  })

  it('keeps the last durable preferences when writing fails', () => {
    writeSettingsRaw(getDefaultAppSettings(false))
    data.fail = true
    expect(() => writeSettingsRaw({ ...readSettingsRaw(), enterToSend: false })).toThrow('Storage unavailable')
    expect(readSettingsRaw().enterToSend).toBe(true)
  })

  it('preserves an existing empty or malformed record while returning safe defaults', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const raw of ['', '{']) {
      data.raw = raw
      resetSettingsCacheForTest()
      expect(readSettingsRaw().enterToSend).toBe(true)
      expect(data.raw).toBe(raw)
    }
    vi.restoreAllMocks()
  })

  it('does not let a consumer mutate cached arrays or search configuration', () => {
    const settings = readSettingsRaw()
    settings.hiddenPlatforms.push('other')
    settings.defaultSearchEngine.name = 'other'
    expect(readSettingsRaw().hiddenPlatforms).toEqual([])
    expect(readSettingsRaw().defaultSearchEngine.name).toBe('Bing')
  })

  it('rejects malformed runtime updates before persisting them', () => {
    for (const patch of [{ autoLaunch: 'false' }, { logLevel: 'trace' }, { cookiePopupCooldownMs: NaN }, { defaultSearchEngine: [] }, { topBarVisibleButtons: ['invalid'] }]) {
      expect(() => validateAppSettingsPatch(patch)).toThrow()
    }
    expect(data.raw).toBeNull()
    expect(validateAppSettingsPatch({ enterToSend: false, chatSidebarWidth: 212, cookieWhitelist: ['example.com'] })).toEqual({
      enterToSend: false, chatSidebarWidth: 212, cookieWhitelist: ['example.com'],
    })
  })

  it('seeds defaults for a genuinely missing table key', () => {
    for (const missing of [null, undefined]) {
      data.raw = missing
      resetSettingsCacheForTest()
      expect(readSettingsRaw().closeBehavior).toBe('minimize')
      expect(JSON.parse(data.raw!)).toEqual(getDefaultAppSettings(false))
    }
  })
})
