import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileDownloadSettings } from '../shared/download-settings.types.js'

const state = vi.hoisted(() => ({
  settings: { downloadDir: 'E:/global/downloads', downloadBehavior: 'ask' } as {
    downloadDir: string
    downloadBehavior: 'ask' | 'auto'
  },
  updateAppSettings: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'E:/system/downloads' },
}))
vi.mock('../store/app-settings-repository.js', () => ({
  getAppSettings: () => state.settings,
}))
vi.mock('../store/app-settings-store.js', () => ({
  updateAppSettings: state.updateAppSettings,
}))

import { rememberDownloadDefault, resolveDownloadSettings } from './download-settings.js'

const custom = (patch: Partial<ProfileDownloadSettings> = {}): ProfileDownloadSettings => ({
  mode: 'custom',
  downloadDir: 'E:/app/downloads',
  downloadBehavior: 'auto',
  ...patch,
})

beforeEach(() => {
  vi.resetAllMocks()
  state.settings = { downloadDir: 'E:/global/downloads', downloadBehavior: 'ask' }
})

describe('effective download settings', () => {
  it('follows the main application default when the AI app has no own setting', () => {
    const resolved = resolveDownloadSettings(undefined)
    expect(resolved).toEqual({
      downloadDir: 'E:/global/downloads',
      downloadBehavior: 'ask',
      source: 'global',
    })
  })

  it('follows the main application default when the AI app is set to default mode', () => {
    const resolved = resolveDownloadSettings({ mode: 'default' })
    expect(resolved.source).toBe('global')
    expect(resolved.downloadDir).toBe('E:/global/downloads')
  })

  it('uses the AI application own setting when it is in custom mode', () => {
    const resolved = resolveDownloadSettings(custom())
    expect(resolved).toEqual({
      downloadDir: 'E:/app/downloads',
      downloadBehavior: 'auto',
      source: 'profile',
    })
  })

  it('falls back to the global directory when the custom setting has no directory', () => {
    const resolved = resolveDownloadSettings({ mode: 'custom' })
    expect(resolved.downloadDir).toBe('E:/global/downloads')
    expect(resolved.downloadBehavior).toBe('ask')
  })

  it('falls back to the system download directory when nothing is configured', () => {
    state.settings = { downloadDir: '', downloadBehavior: 'ask' }
    const resolved = resolveDownloadSettings(undefined)
    expect(resolved.downloadDir).toBe('E:/system/downloads')
  })
})

describe('remembering a default location', () => {
  it('writes to the global settings when the AI app follows the main application', async () => {
    await rememberDownloadDefault({ override: { mode: 'default' } }, 'E:/chosen')
    expect(state.updateAppSettings).toHaveBeenCalledWith({
      downloadDir: 'E:/chosen',
      downloadBehavior: 'auto',
    })
  })

  it('writes to the AI application when it has its own setting', async () => {
    const saveOverride = vi.fn()
    await rememberDownloadDefault({ override: custom(), saveOverride }, 'E:/chosen')
    expect(saveOverride).toHaveBeenCalledWith({
      mode: 'custom',
      downloadDir: 'E:/chosen',
      downloadBehavior: 'auto',
    })
    expect(state.updateAppSettings).not.toHaveBeenCalled()
  })

  it('writes to the global settings when the AI app has no writer', async () => {
    await rememberDownloadDefault({ override: custom() }, 'E:/chosen')
    expect(state.updateAppSettings).toHaveBeenCalledWith({
      downloadDir: 'E:/chosen',
      downloadBehavior: 'auto',
    })
  })
})
