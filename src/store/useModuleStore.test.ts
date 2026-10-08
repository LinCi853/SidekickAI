import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleInfo } from '../lib/electron-api/core';

let store: typeof import('./useModuleStore')['useModuleStore'];
let registerGuest: typeof import('../lib/electron-api/window')['registerWebview'];
let changed: (payload: { modules: ModuleInfo[] }) => void;
const list = vi.fn();
const setEnabled = vi.fn();
const clearData = vi.fn();
const subscribe = vi.fn();
const registerWebview = vi.fn();
function moduleInfo(enabled: boolean): ModuleInfo {
  return { id: 'prompt-library', name: 'Assets', enabled } as ModuleInfo;
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  list.mockResolvedValue([moduleInfo(true)]);
  setEnabled.mockResolvedValue({ ok: true });
  clearData.mockResolvedValue({ ok: true });
  registerWebview.mockResolvedValue(true);
  subscribe.mockImplementation(callback => { changed = callback; return vi.fn(); });
  vi.stubGlobal('window', {
    electron: { modules: { list, setEnabled, clearData, onStateChanged: subscribe },
      window: { registerWebview } },
  });
  ({ useModuleStore: store } = await import('./useModuleStore'));
  ({ registerWebview: registerGuest } = await import('../lib/electron-api/window'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('module store consumers', () => {
  it('loads modules and subscribes only once across repeated initialization', async () => {
    expect(store.getState().initialized).toBe(false);
    await store.getState().init();
    await store.getState().init();
    expect(list).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ initialized: true, subscribed: true });
    expect(store.getState().isEnabled('prompt-library')).toBe(true);
    expect(store.getState().getModule('prompt-library')).toEqual(moduleInfo(true));
    expect(store.getState().isEnabled('missing')).toBe(false);
    expect(store.getState().getModule('missing')).toBeUndefined();
  });
  it('retains existing modules on a read failure and still receives later broadcasts', async () => {
    store.setState({ modules: [moduleInfo(true)] });
    list.mockRejectedValue(new Error('Unavailable'));
    await store.getState().init();
    expect(store.getState()).toMatchObject({ initialized: true, subscribed: true });
    expect(store.getState().isEnabled('prompt-library')).toBe(true);
    changed({ modules: [moduleInfo(false)] });
    expect(store.getState().isEnabled('prompt-library')).toBe(false);
  });
  it('refreshes modules after an accepted enable change', async () => {
    list.mockResolvedValue([moduleInfo(false)]);
    const result = await store.getState().setEnabled('prompt-library', false);
    expect(result).toEqual({ ok: true });
    expect(setEnabled).toHaveBeenCalledWith('prompt-library', false);
    expect(list).toHaveBeenCalledOnce();
    expect(store.getState().isEnabled('prompt-library')).toBe(false);
  });
  it('keeps the current list and returns a rejected enable result', async () => {
    store.setState({ modules: [moduleInfo(true)] });
    const rejection = { ok: false, error: 'Module unavailable' };
    setEnabled.mockResolvedValue(rejection);
    expect(await store.getState().setEnabled('prompt-library', false)).toBe(rejection);
    expect(list).not.toHaveBeenCalled();
    expect(store.getState().isEnabled('prompt-library')).toBe(true);
  });
  it('propagates an enable refresh failure without replacing current modules', async () => {
    store.setState({ modules: [moduleInfo(true)] });
    const failure = new Error('Read failed');
    list.mockRejectedValue(failure);
    await expect(store.getState().setEnabled('prompt-library', false)).rejects.toBe(failure);
    expect(store.getState().isEnabled('prompt-library')).toBe(true);
  });
  it.each([true, false])('returns the clear-data result unchanged for ok=%s', async ok => {
    const result = { ok, error: ok ? undefined : 'Clear rejected' };
    clearData.mockResolvedValue(result);
    expect(await store.getState().clearData('prompt-library')).toBe(result);
    expect(clearData).toHaveBeenCalledWith('prompt-library');
    expect(list).not.toHaveBeenCalled();
  });
  it('registers guest identity independently of optional module state', async () => {
    const payload = { tabId: 'tab', windowId: 'main', profileId: 'profile', webContentsId: 123 };
    expect(await registerGuest(payload)).toBe(true);
    expect(registerWebview).toHaveBeenCalledWith(payload);
    await store.getState().init();
    expect(await registerGuest(payload)).toBe(true);
    expect(registerWebview).toHaveBeenCalledWith(payload);
    registerWebview.mockClear();
    changed({ modules: [moduleInfo(false)] });
    expect(await registerGuest(payload)).toBe(true);
    expect(registerWebview).toHaveBeenCalledWith(payload);
  });
});
