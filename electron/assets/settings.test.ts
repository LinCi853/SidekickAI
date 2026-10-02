import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSET_SETTINGS, mergeAssetSettings, normalizeAssetAccelerator } from '../shared/asset-settings'
describe('asset shortcut preferences', () => {
  it('normalizes modifier aliases and rejects duplicate, reserved and malformed combinations', () => {
    expect(normalizeAssetAccelerator('CommandOrControl+Shift+F')).toBe(normalizeAssetAccelerator('Shift+Ctrl+f'))
    expect(() => mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { localShortcuts: { ...DEFAULT_ASSET_SETTINGS.localShortcuts, prompts: 'Control+1' } })).toThrow('重复')
    expect(() => mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { localShortcuts: { ...DEFAULT_ASSET_SETTINGS.localShortcuts, search: 'Ctrl+W' } })).toThrow()
    expect(() => mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { localShortcuts: { ...DEFAULT_ASSET_SETTINGS.localShortcuts, search: 'F' } })).toThrow()
    expect(mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { localShortcuts: { ...DEFAULT_ASSET_SETTINGS.localShortcuts, search: '' } }).localShortcuts.search).toBe('')
  })
})
