import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewElement } from '../../lib/webview';
import type { WebviewHotkeyPayload } from '../../../electron/shared/types';
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({
  listeners: new Set<(payload: WebviewHotkeyPayload) => void>(), validate: vi.fn(), close: vi.fn(), focus: vi.fn(),
  browser: { activeTabId: 'first', windowId: 'browser-window', profileId: 'profile', tabs: [{ id: 'first', profileId: 'profile' }, { id: 'second', profileId: 'profile' }] },
  main: { activeTabId: 'first', windowId: 'main', tabs: [{ id: 'first', profileId: 'profile' }, { id: 'second', profileId: 'profile' }] },
}));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../hooks/useShortcutRegistry', () => ({ useShortcutRegistry: vi.fn() }));
vi.mock('../../store/useBrowserTabStore', () => ({ useBrowserTabStore: { getState: () => ({ ...state.browser, closeTab: state.close }) } }));
vi.mock('../../store/useTabStore', () => ({ useTabStore: { getState: () => state.main } }));
vi.mock('../../store/useModuleStore', () => ({ useModuleStore: { getState: () => ({ isEnabled: () => false }) } }));
vi.mock('../../store/useProfileStore', () => ({ useProfileStore: { getState: () => ({ profiles: [] }) } }));
vi.mock('../../store/useThemeStore', () => ({ useThemeStore: { getState: () => ({ toggleTheme: vi.fn() }) } }));
vi.mock('../../hooks/useWebViewControl', () => ({ focusInputInWebview: vi.fn() }));
vi.mock('./RecentClosedStore', () => ({ useRecentClosedStore: { getState: () => ({ entries: [] }) } }));
vi.mock('../../lib/electron-api', () => ({
  onWebviewHotkey: (listener: (payload: WebviewHotkeyPayload) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  validateWebviewHotkeyTarget: state.validate, onToggleDevTools: () => () => {}, maximizeToggleWindow: vi.fn(), openPromptWindow: vi.fn(),
  clearAllNavHistory: vi.fn(), clearAllDownloads: vi.fn(),
}));
vi.mock('../../lib/webview', () => ({ safeReloadWebview: vi.fn() }));

import { useBrowserShortcuts } from './hooks/useBrowserShortcuts';
import { useWebviewHotkeyDispatch } from '../MainView/hooks/useWebviewHotkeyDispatch';

function webviewFixture() {
  const events = new EventTarget();
  return Object.assign(events, { getWebContentsId: () => 7, getURL: () => 'https://fixture.test/page' }) as unknown as WebviewElement;
}

function mountConsumer(kind: 'browser' | 'main', view: WebviewElement) {
  let current: WebviewElement | null = view;
  vi.stubGlobal('document', { querySelector: () => current });
  if (kind === 'main') {
    harness.mount(() => useWebviewHotkeyDispatch(vi.fn(), state.close, vi.fn(), vi.fn(), { current: true }));
  } else {
    const noop = () => {};
    const parameters = {
      addressBarRef: { current: null }, bookmarkBarVisible: false, setBookmarkBarVisible: noop, isFullscreen: false, isCloudPc: false,
      handleRefresh: noop, handleGoBack: noop, handleGoForward: noop, handleStopLoading: noop, handleForceRefresh: noop,
      handleToggleDevTools: noop, handleToggleFullscreen: noop, handleExitFullscreen: noop, handleFocusCycle: state.focus,
      focusCycleRef: { current: state.focus }, handleAddBookmark: noop, handleFocusSearch: noop, handleFindInPage: noop,
      handlePrint: noop, handleSavePageAs: noop, handleViewSource: noop, zoomInAction: noop, zoomOutAction: noop, zoomResetAction: noop,
      toggleCloudPc: noop, handleToggleSpatialNav: noop,
    };
    harness.mount(() => useBrowserShortcuts(parameters));
  }
  return { replace: (replacement: WebviewElement | null) => { current = replacement; } };
}

function payload(kind: 'browser' | 'main'): WebviewHotkeyPayload {
  return { action: 'closeTab', target: { webContentsId: 7, documentGeneration: 2, url: 'https://fixture.test/page',
    tabId: 'first', profileId: 'profile', windowId: kind === 'main' ? 'main' : 'browser-window' } };
}

const emit = (value: WebviewHotkeyPayload) => state.listeners.forEach(listener => listener(value));
beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); state.listeners.clear(); state.validate.mockResolvedValue(true);
  state.browser.activeTabId = 'first'; state.main.activeTabId = 'first';
});
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); });

describe('browser shortcut ownership', () => {
  it('uses one subscription for close and focus while preserving non-guest actions', () => {
    mountConsumer('browser', webviewFixture()); expect(state.listeners.size).toBe(1);
    emit({ action: 'closeTab' }); emit({ action: 'focusCycle' });
    expect(state.close).toHaveBeenCalledOnce(); expect(state.close).toHaveBeenCalledWith('first'); expect(state.focus).toHaveBeenCalledOnce();
    harness.unmount(); expect(state.listeners.size).toBe(0);
  });
});

describe.each(['main', 'browser'] as const)('%s forwarded target validation', kind => {
  it('executes a still current validated guest once', async () => {
    mountConsumer(kind, webviewFixture()); emit(payload(kind)); await settleHooks();
    expect(state.validate).toHaveBeenCalledOnce(); expect(state.close).toHaveBeenCalledOnce(); expect(state.close).toHaveBeenCalledWith('first');
  });

  it.each(['navigation', 'selection', 'replacement', 'unmount'] as const)('rejects validation that returns after %s', async change => {
    const view = webviewFixture(); const mounted = mountConsumer(kind, view); const pending = deferred<boolean>();
    state.validate.mockReturnValue(pending.promise); emit(payload(kind)); await settleHooks();
    if (change === 'navigation') view.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true }));
    else if (change === 'selection') state[kind].activeTabId = 'second';
    else if (change === 'replacement') mounted.replace(webviewFixture());
    else harness.unmount();
    pending.resolve(true); await settleHooks(); expect(state.close).not.toHaveBeenCalled();
  });

  it('rejects a wrong profile before asking the main process', async () => {
    mountConsumer(kind, webviewFixture()); const value = payload(kind); value.target!.profileId = 'other';
    emit(value); await settleHooks(); expect(state.validate).not.toHaveBeenCalled(); expect(state.close).not.toHaveBeenCalled();
  });

  it('handles a rejected or synchronously unavailable validation without dispatch', async () => {
    mountConsumer(kind, webviewFixture()); state.validate.mockImplementation(() => { throw new Error('Unavailable'); });
    emit(payload(kind)); await settleHooks(); expect(state.close).not.toHaveBeenCalled();
  });
});
