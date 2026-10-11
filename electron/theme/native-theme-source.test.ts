import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ themeSource: 'system' as string }))
vi.mock('electron', () => ({
  nativeTheme: {
    get themeSource() { return state.themeSource },
    set themeSource(value: string) { state.themeSource = value },
  },
}))

import {
  applyUiThemeBroadcast,
  resolveEffectiveThemeMode,
  setNativeThemeSource,
  type ThemeMode,
} from './native-theme-source.js'

describe('native theme source mapping', () => {
  beforeEach(() => {
    state.themeSource = 'system'
  })

  it('maps selected light/dark/system modes verbatim', () => {
    expect(resolveEffectiveThemeMode('classic', 'light')).toBe('light')
    expect(resolveEffectiveThemeMode('classic', 'dark')).toBe('dark')
    expect(resolveEffectiveThemeMode('classic', 'system')).toBe('system')
  })

  it('forces light while the Oxy design system is active', () => {
    expect(resolveEffectiveThemeMode('oxy', 'dark')).toBe('light')
    expect(resolveEffectiveThemeMode('oxy', 'system')).toBe('light')
  })

  it('falls back to system on unexpected broadcast payloads', () => {
    expect(resolveEffectiveThemeMode('classic', 'purple' as ThemeMode)).toBe('system')
    expect(applyUiThemeBroadcast('classic', undefined as unknown as ThemeMode)).toBe('system')
    expect(state.themeSource).toBe('system')
  })

  it('applies the effective mode to Chromium on theme broadcasts', () => {
    expect(applyUiThemeBroadcast('classic', 'dark')).toBe('dark')
    expect(state.themeSource).toBe('dark')
    expect(applyUiThemeBroadcast('oxy', 'dark')).toBe('light')
    expect(state.themeSource).toBe('light')
  })

  it('restores the persisted mode at startup', () => {
    setNativeThemeSource('dark')
    expect(state.themeSource).toBe('dark')
    setNativeThemeSource('system')
    expect(state.themeSource).toBe('system')
  })
})
