import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetSettings } from '../../electron/shared/ai-assets.types';
import { DEFAULT_ASSET_SETTINGS } from '../../electron/shared/asset-settings';
import { deferred, settleHooks } from './draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('./draft-hook-test-harness')).createHookHarness());
const api = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn(), onSettingsChanged: vi.fn() }));
const bridge = vi.hoisted(() => ({ assets: undefined as unknown }));
vi.mock('react', () => harness.react);
vi.mock('../lib/electron-api/core', () => ({ requireElectron: () => ({ aiAssets: bridge.assets }) }));
import { useAssetSettings } from './useAssetSettings';
let broadcast: (value: AssetSettings) => void;
const recent = { ...DEFAULT_ASSET_SETTINGS, expandReasoning: true };
const views = { ...DEFAULT_ASSET_SETTINGS, sort: 'views' as const };

beforeEach(() => {
  harness.reset(); vi.resetAllMocks();
  bridge.assets = api;
  api.settings.mockResolvedValue(DEFAULT_ASSET_SETTINGS); api.updateSettings.mockResolvedValue(views);
  api.onSettingsChanged.mockImplementation(handler => { broadcast = handler; return () => {}; });
});
afterEach(async () => { harness.unmount(); await settleHooks(); vi.unstubAllGlobals(); });

describe('asset settings ownership', () => {
  it('keeps a broadcast instead of a late initial snapshot', async () => {
    const initial = deferred<AssetSettings>(); api.settings.mockReturnValueOnce(initial.promise);
    const hook = harness.mount(useAssetSettings); broadcast(recent); initial.resolve(DEFAULT_ASSET_SETTINGS); await settleHooks();
    expect(hook.current.settings).toEqual(recent);
  });

  it('keeps a local save instead of a late initial snapshot', async () => {
    const initial = deferred<AssetSettings>(); api.settings.mockReturnValueOnce(initial.promise);
    const hook = harness.mount(useAssetSettings); await hook.current.update({ sort: 'views' });
    initial.resolve(DEFAULT_ASSET_SETTINGS); await settleHooks();
    expect(hook.current.settings).toEqual(views);
  });

  it('keeps a newer broadcast instead of an older local save response', async () => {
    const pending = deferred<AssetSettings>(); api.updateSettings.mockReturnValueOnce(pending.promise);
    const hook = harness.mount(useAssetSettings); await settleHooks();
    const saving = hook.current.update({ sort: 'views' }); broadcast(recent); pending.resolve(views); await saving; await settleHooks();
    expect(hook.current.settings).toEqual(recent);
  });

  it('does not recover a failed old save over a newer broadcast', async () => {
    const pending = deferred<AssetSettings>(); api.updateSettings.mockReturnValueOnce(pending.promise);
    const hook = harness.mount(useAssetSettings); await settleHooks();
    const saving = hook.current.update({ sort: 'views' }); broadcast(recent); pending.reject(new Error('Old save failed')); await saving; await settleHooks();
    expect(hook.current.settings).toEqual(recent); expect(hook.current.error).toBe('');
    expect(api.settings).toHaveBeenCalledTimes(1);
  });

  it('discards a recovery snapshot after a newer local save', async () => {
    const recovery = deferred<AssetSettings>(); const hook = harness.mount(useAssetSettings); await settleHooks();
    api.settings.mockReturnValueOnce(recovery.promise); api.updateSettings.mockRejectedValueOnce(new Error('Save failed'));
    const saving = hook.current.update({ expandReasoning: true }); await settleHooks();
    await hook.current.update({ sort: 'views' }); recovery.resolve(DEFAULT_ASSET_SETTINGS); await saving; await settleHooks();
    expect(hook.current.settings).toEqual(views); expect(hook.current.error).toBe('');
  });

  it('discards a recovery snapshot after a newer broadcast', async () => {
    const recovery = deferred<AssetSettings>(); const hook = harness.mount(useAssetSettings); await settleHooks();
    api.settings.mockReturnValueOnce(recovery.promise); api.updateSettings.mockRejectedValueOnce(new Error('Save failed'));
    const saving = hook.current.update({ sort: 'views' }); await settleHooks();
    broadcast(recent); recovery.resolve(DEFAULT_ASSET_SETTINGS); await saving; await settleHooks();
    expect(hook.current.settings).toEqual(recent); expect(hook.current.error).toBe('');
  });

  it('catches failure of the recovery read without rejecting the UI operation', async () => {
    const hook = harness.mount(useAssetSettings); await settleHooks();
    api.updateSettings.mockRejectedValueOnce(new Error('Save failed')); api.settings.mockRejectedValueOnce(new Error('Read failed'));
    await expect(hook.current.update({ sort: 'views' })).resolves.toBeUndefined(); await settleHooks();
    expect(hook.current.error).toContain('Save failed'); expect(hook.current.error).toContain('Read failed');
  });

  it('does not start a recovery read when the component was unmounted', async () => {
    const pending = deferred<AssetSettings>(); api.updateSettings.mockReturnValueOnce(pending.promise);
    const hook = harness.mount(useAssetSettings); await settleHooks();
    const saving = hook.current.update({ sort: 'views' }); harness.unmount(); pending.reject(new Error('Save failed')); await saving;
    expect(api.settings).toHaveBeenCalledTimes(1);
  });

  it('ignores a retired subscription after the API instance changes', async () => {
    const hook = harness.mount(useAssetSettings); await settleHooks();
    const retired = broadcast; bridge.assets = { ...api };
    harness.mount(useAssetSettings); await settleHooks(); broadcast(recent); retired(views); await settleHooks();
    expect(hook.current.settings).toEqual(recent);
  });
});
