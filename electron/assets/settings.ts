import type { AssetSettings } from '../shared/ai-assets.types.js'
import { DEFAULT_ASSET_SETTINGS, mergeAssetSettings, normalizeAssetAccelerator } from '../shared/asset-settings.js'
import { createSqliteJsonStore } from '../store/module-state-store.js'
import { hotkeyStore } from '../hotkey/store.js'
const store = createSqliteJsonStore({ tableName: 'asset_preferences', defaults: { settings: DEFAULT_ASSET_SETTINGS } })
export function getAssetSettings(): AssetSettings { return mergeAssetSettings(DEFAULT_ASSET_SETTINGS, store.get('settings')) }
export function updateAssetSettings(changes: Partial<AssetSettings>): AssetSettings {
  const next = mergeAssetSettings(getAssetSettings(), changes)
  const globalAccelerator = hotkeyStore.get('hotkey.toggleAiAssets')
  if (globalAccelerator && Object.values(next.localShortcuts).some(value => normalizeAssetAccelerator(value) === normalizeAssetAccelerator(globalAccelerator))) throw new Error('局部快捷键与打开／关闭 AI资产的全局快捷键重复')
  store.set('settings', next)
  return next
}
