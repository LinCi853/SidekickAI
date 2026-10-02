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
  const active = useRef(false);
  const apply = (value: AssetSettings) => { current.current = value; setSettings(value); };
  const owns = (operation: number) => active.current && operation === request.current;
  useEffect(() => {
    active.current = true;
    let listening = true;
    const operation = ++request.current;
    const off = api.onSettingsChanged(value => {
      if (!listening || !active.current) return;
      request.current += 1;
      setError('');
      apply(value);
    });
    void api.settings().then(value => { if (owns(operation)) apply(value); }).catch(failure => { if (owns(operation)) setError(String(failure)); });
    return () => { listening = false; active.current = false; request.current += 1; off(); };
  }, [api]);
  const update = async (changes: Partial<AssetSettings>) => {
    if (!active.current) return;
    const operation = ++request.current;
    setError('');
    try {
      apply(mergeAssetSettings(current.current, changes));
      const value = await api.updateSettings(changes);
      if (owns(operation)) apply(value);
    } catch (failure) {
      if (!owns(operation)) return;
      setError(String(failure));
      const recovery = ++request.current;
      try {
        const value = await api.settings();
        if (owns(recovery)) apply(value);
      } catch (readFailure) {
        if (owns(recovery)) setError(`${String(failure)}；重新读取设置失败：${String(readFailure)}`);
      }
    }
  };
  return { settings, update, error };
}
