import { updateAppSettings } from '../lib/electron-api';
import type { AppSettingsState } from './useSettingsData';

type ActionSettings = Pick<AppSettingsState,
  'hideForeignModels' | 'setHideForeignModels' |
  'disableAllBlockRules' | 'setDisableAllBlockRules' |
  'altSpaceResetThreshold' | 'setAltSpaceResetThreshold'>;

export function createPlatformSettingsActions(app: ActionSettings, source: 'SettingsPanel' | 'SettingsView') {
  const toggleForeignModels = async () => {
    const next = !app.hideForeignModels;
    app.setHideForeignModels(next);
    try {
      await updateAppSettings({ hideForeignModels: next });
    } catch (error) {
      console.error(`[${source}] Foreign model visibility update failed:`, error);
      app.setHideForeignModels(app.hideForeignModels);
    }
  };
  const toggleBlocking = async () => {
    const next = !app.disableAllBlockRules;
    app.setDisableAllBlockRules(next);
    try {
      await updateAppSettings({ disableAllBlockRules: next });
    } catch (error) {
      console.error(`[${source}] Content blocking update failed:`, error);
      app.setDisableAllBlockRules(app.disableAllBlockRules);
    }
  };
  const changeThreshold = async (value: number) => {
    const next = Math.max(3, Math.min(20, value));
    const previous = app.altSpaceResetThreshold;
    app.setAltSpaceResetThreshold(next);
    try {
      await updateAppSettings({ altSpaceResetThreshold: next });
    } catch (error) {
      console.error(`[${source}] Alt+Space threshold update failed:`, error);
      app.setAltSpaceResetThreshold(previous);
    }
  };
  return { toggleForeignModels, toggleBlocking, changeThreshold };
}
