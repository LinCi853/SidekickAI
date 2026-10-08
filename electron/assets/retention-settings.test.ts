import { describe, expect, it } from 'vitest'
import { DEFAULT_ASSET_SETTINGS, mergeAssetSettings } from '../shared/asset-settings'
describe('attachment retention preferences', () => {
  it('defaults legacy settings to off and ignores the removed freeze shortcut', () => {
    const legacy = { localShortcuts: { ...DEFAULT_ASSET_SETTINGS.localShortcuts, freeze: 'Ctrl+F' } }
    const merged = mergeAssetSettings(DEFAULT_ASSET_SETTINGS, legacy)
    expect(merged.fileRetentionDays).toBe(0); expect(merged.localShortcuts).not.toHaveProperty('freeze')
  })
  it.each([0, 14, 30, 120] as const)('accepts the %i-day option', fileRetentionDays => {
    expect(mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { fileRetentionDays }).fileRetentionDays).toBe(fileRetentionDays)
  })
  it.each([-1, 1, 31, NaN, '14', null, undefined])('rejects an invalid retention setting %s', value => {
    expect(() => mergeAssetSettings(DEFAULT_ASSET_SETTINGS, { fileRetentionDays: value as any })).toThrow()
  })
})
