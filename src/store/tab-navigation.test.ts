import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserTabState, Profile, TabState } from '../lib/electron-api';
const api = vi.hoisted(() => ({
  getWindowState: vi.fn(), saveWindowState: vi.fn(), getWindowBounds: vi.fn(), setupSession: vi.fn(),
  updateTabTitle: vi.fn(), updateTabUrl: vi.fn(), updateTabHomeUrl: vi.fn(), detachTab: vi.fn(),
  pinCurrentWindow: vi.fn(), maximizeToggleWindow: vi.fn(), onMaximizeToggled: vi.fn(), onPinToggled: vi.fn(),
  getBrowserState: vi.fn(), saveBrowserState: vi.fn(), onToggleFullscreen: vi.fn(), queryAllTabs: vi.fn(),
}));
vi.mock('../lib/electron-api', () => api);
vi.mock('./useProfileStore', () => ({ useProfileStore: { getState: () => ({ profiles: [profile] }) } }));
const profile = { id: 'profile-a', name: 'A', browserHomePage: 'https://home.test' } as Profile;
const tab = (id: string): TabState => ({ id, profileId: profile.id, title: id, order: 0 });
const browserTab = (id: string): BrowserTabState => ({
  ...tab(id), url: `https://${id}.test`, source: 'new', kind: 'web', isLoading: false, canGoBack: false, canGoForward: false,
});
let main: typeof import('./useTabStore').useTabStore;
let browser: typeof import('./useBrowserTabStore').useBrowserTabStore;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  api.setupSession.mockResolvedValue(undefined);
  api.getWindowBounds.mockResolvedValue({ width: 800, height: 600 });
  api.pinCurrentWindow.mockResolvedValue(undefined);
  main = (await import('./useTabStore')).useTabStore;
  browser = (await import('./useBrowserTabStore')).useBrowserTabStore;
  main.setState({ tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'a' });
  browser.setState({ windowId: 'browser', profileId: profile.id, tabs: [browserTab('a'), browserTab('b')], activeTabId: 'a' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('preserves concurrent tab changes while a new session is prepared', async () => {
  let finish!: () => void;
  api.setupSession.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const opening = main.getState().addTab({ ...profile, id: 'new-profile' });
  main.getState().setActiveTab('b');
  main.getState().insertTabAfterParent('c', [tab('d')]);
  finish(); await opening;
  const state = main.getState();
  expect(state.tabs.map(item => item.id)).toEqual(['a', 'b', 'c', 'd', state.activeTabId]);
  expect(state.tabs.at(-1)?.order).toBe(4);
});
it('reasserts topmost when focusing an existing page in either window', async () => {
  main.setState({ alwaysOnTop: true, tabs: [{ ...tab('a'), url: 'https://a.test' }, { ...tab('b'), profileId: 'other' }], activeTabId: 'b' });
  await main.getState().addTab(profile);
  expect(main.getState().activeTabId).toBe('a');
  browser.setState({ alwaysOnTop: true });
  expect(browser.getState().openTabOrFocus('https://b.test')).toBe('b');
  expect(api.pinCurrentWindow).toHaveBeenCalledTimes(2);
});
it('gives the replacement browser home page a fresh identity', async () => {
  browser.setState({ tabs: [browserTab('a'), { ...browserTab('settings'), source: 'settings' }], activeTabId: 'settings' });
  await browser.getState().closeTab('a');
  const state = browser.getState();
  expect(state.activeTabId).not.toBe('a');
  expect(state.tabs[0]).toMatchObject({ profileId: profile.id, kind: 'home', source: 'initial', url: profile.browserHomePage });
});
it('leaves no active main tab when the final tab closes', async () => {
  main.setState({ tabs: [tab('a')], activeTabId: 'a' });
  await main.getState().closeTab('a');
  expect(main.getState().tabs).toEqual([]);
  expect(main.getState().activeTabId).toBeNull();
});
