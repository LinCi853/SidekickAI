import { useEffect, useRef, useState } from 'react';
import type { AssetSettings } from '../../electron/shared/ai-assets.types';
import { DEFAULT_ASSET_SETTINGS, mergeAssetSettings } from '../../electron/shared/asset-settings';
import { requireElectron } from '../lib/electron-api/core';
export function useAssetSettings() {
  const api = requireElectron().aiAssets;
  const [settings, setSettings] = useState<AssetSettings>(DEFAULT_ASSET_SETTINGS);
  const [error, setError] = useState('');
  const current = useRef(settings);
  const request = useRef(0);
  const apply = (value: AssetSettings) => { current.current = value; setSettings(value); };
  useEffect(() => {
    let active = true;
    let changed = false;
    const off = api.onSettingsChanged(value => { changed = true; if (active) apply(value); });
    void api.settings().then(value => { if (active && !changed) apply(value); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; off(); };
  }, [api]);
  const update = async (changes: Partial<AssetSettings>) => {
    const operation = ++request.current;
    setError('');
    try {
      apply(mergeAssetSettings(current.current, changes));
      const value = await api.updateSettings(changes);
      if (operation === request.current) apply(value);
    } catch (failure) {
      if (operation === request.current) { setError(String(failure)); apply(await api.settings()); }
    }
  };
  return { settings, update, error };
}
