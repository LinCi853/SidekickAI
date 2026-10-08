import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabState, Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';
import { deferred, settleHooks } from '../../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../../../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ preset: vi.fn(), fingerprint: vi.fn(), inject: vi.fn(), cleanup: vi.fn(), register: vi.fn(), fallback: vi.fn(),
  store: { windowId: 'browser-window', navigateTab: vi.fn(), updateTabTitle: vi.fn(), updateTabFavicon: vi.fn(), updateTabThemeColor: vi.fn(),
    updateTabNavState: vi.fn(), updateTabLoading: vi.fn(), updateTabLoadingStatus: vi.fn(), updateTabLoadingProgress: vi.fn() },
}));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../../lib/electron-api', () => ({ getPreset: state.preset, getFingerprintScript: state.fingerprint,
  registerWebview: state.register, applyProxyFallback: state.fallback, recordNavHistory: async () => {}, onWebviewPopupUrl: () => () => {} }));
vi.mock('../../../lib/webview.js', () => ({ injectViewportAndPopupGuard: async () => {}, safeLoadURLWebview: vi.fn() }));
vi.mock('../../../lib/injection-manager.js', () => ({ injectionManager: { injectAll: state.inject, disposeWebview: state.cleanup } }));
vi.mock('../../../store/useBrowserTabStore.js', () => ({ useBrowserTabStore: Object.assign(() => state.store, { getState: () => state.store }) }));
vi.mock('../../../store/useCloudPcStore.js', () => ({ useCloudPcStore: { getState: () => ({ isActive: false }) } }));
vi.mock('../../../store/useGamepadStore.js', () => ({ useGamepadStore: { getState: () => ({ connectedCount: 0 }) } }));
vi.mock('../../../lib/webview-spatial-nav.js', () => ({ buildSpatialNavScript: () => 'spatial' }));
vi.mock('../utils/favicon-placeholder.js', () => ({ extractThemeColor: async () => null }));
vi.mock('../webview-scripts.js', () => ({ GET_TITLE_SCRIPT: 'title', SPATIAL_NAV_ENABLE_SCRIPT: 'enable',
  buildFaviconToDataUrlScript: () => 'favicon', buildImageUrlToDataUrlScript: () => 'favicon', FILE_DROP_BRIDGE_SCRIPT: 'drop', CONTEXT_COORD_HOOK_SCRIPT: 'context' }));

import { useWebviewDomReady } from './useWebviewDomReady';
import { useWebviewLifecycle } from './useWebviewLifecycle';
import { useWebviewNavigation } from './useWebviewNavigation';
import { useWebviewLoadingProgress } from './useWebviewLoadingProgress';

const tab: BrowserTabState = { id: 'tab', profileId: 'profile', title: 'Fixture', url: 'https://fixture.test/page',
  source: 'new', kind: 'web', order: 0, isLoading: false, canGoBack: false, canGoForward: false };
const profile = { id: 'profile', aiPlatformId: 'deepseek' } as Profile;
function fixture() {
  const target = new EventTarget();
  const view = Object.assign(target, { getWebContentsId: () => 1, getURL: () => tab.url, executeJavaScript: vi.fn().mockResolvedValue('Fixture title'),
    setUserAgent: vi.fn(), reload: vi.fn(), loadURL: vi.fn(), canGoBack: () => false, canGoForward: () => false }) as unknown as WebviewElement;
  const emit = (event: string, details = {}) => view.dispatchEvent(Object.assign(new Event(event), details));
  return { view, webviewRef: { current: view as WebviewElement | null }, domReadyRef: { current: true }, emit, remountKey: 0, tab, profile };
}

function lifecycleHandlers() {
  const noop = vi.fn();
  return { handleDomReady: async () => {}, handleNavigate: noop, handleTitleUpdate: noop, handleFaviconUpdate: noop,
    handleStartLoading: noop, handleStopLoading: noop, handleFinishNavigation: noop, handleFinishLoad: noop,
    handleFailLoad: noop, handleMediaStartedPlaying: noop, handleMediaPaused: noop };
}

beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); vi.useFakeTimers();
  state.preset.mockResolvedValue({ userAgent: 'desktop' }); state.fingerprint.mockResolvedValue('fingerprint');
  state.inject.mockResolvedValue(undefined); state.cleanup.mockResolvedValue(undefined); state.register.mockResolvedValue(true);
  state.fallback.mockResolvedValue({ switched: true, mode: 'direct' });
});
afterEach(() => { harness.unmount(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser webview page ownership', () => {
  it('refreshes AI enhancement and input ownership on SPA navigation without reloading', async () => {
    const parameters = fixture(); parameters.profile = { ...profile, isAIPlatform: true, aiInputSelector: '#input', aiSendSelector: '#send' };
    const mounted = harness.mount(() => useWebviewDomReady(parameters)); parameters.emit('dom-ready'); await mounted.current();
    const before = state.inject.mock.calls[0][3]; parameters.emit('did-navigate-in-page', { isMainFrame: true }); await settleHooks();
    const after = state.inject.mock.calls[1][3];
    expect(after).toMatchObject({ manageEnterToSend: true, inputSelector: '#input', sendSelector: '#send', profileId: 'profile' });
    expect(after.pageGeneration).toBeGreaterThan(before.pageGeneration); expect(before.isCurrent()).toBe(false);
    expect(after.isCurrent()).toBe(true); expect(parameters.view.reload).not.toHaveBeenCalled();
  });
  it.each(['navigation', 'replacement', 'unmount'] as const)('rejects an old preset lookup after %s', async change => {
    const parameters = fixture(); const pending = deferred<{ userAgent: string }>(); state.preset.mockReturnValue(pending.promise);
    const mounted = harness.mount(() => useWebviewDomReady(parameters)); const operation = mounted.current();
    if (change === 'navigation') parameters.emit('did-start-navigation', { isMainFrame: true });
    else if (change === 'replacement') parameters.webviewRef.current = fixture().view;
    else harness.unmount();
    pending.resolve({ userAgent: 'old' }); await operation;
    expect(parameters.view.setUserAgent).not.toHaveBeenCalled(); expect(parameters.view.executeJavaScript).not.toHaveBeenCalled();
  });

  it('stops a title fallback when the page has navigated while its result was pending', async () => {
    const parameters = fixture(); const pending = deferred<unknown>();
    vi.mocked(parameters.view.executeJavaScript).mockImplementation(script => script === 'title' ? pending.promise : Promise.resolve(true));
    const mounted = harness.mount(() => useWebviewDomReady(parameters)); const operation = mounted.current(); await settleHooks();
    parameters.emit('did-start-navigation', { isMainFrame: true }); pending.resolve('Previous title'); await operation;
    expect(state.store.updateTabTitle).not.toHaveBeenCalled(); expect(state.store.updateTabFavicon).not.toHaveBeenCalled();
  });

  it('recovers a crashed guest once and clears listeners and delayed proxy checks', async () => {
    const parameters = fixture(); const recover = vi.fn();
    harness.mount(() => useWebviewLifecycle({ ...parameters, setRemountKey: recover, handlers: lifecycleHandlers() }));
    parameters.emit('did-fail-load', { errorCode: -130, isMainFrame: true });
    parameters.emit('render-process-gone'); parameters.emit('ai-webview-fatal-failure');
    expect(recover).toHaveBeenCalledOnce(); harness.unmount();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(2000);
    expect(parameters.view.executeJavaScript).not.toHaveBeenCalled();
    parameters.emit('render-process-gone'); expect(recover).toHaveBeenCalledOnce();
  });

  it('registers the attached guest with the actual window identity', async () => {
    const parameters = fixture(); harness.mount(() => useWebviewLifecycle({ ...parameters, setRemountKey: vi.fn(), handlers: lifecycleHandlers() }));
    parameters.emit('did-attach'); await settleHooks();
    expect(state.register).toHaveBeenCalledWith({ tabId: 'tab', profileId: 'profile', windowId: 'browser-window', webContentsId: 1 });
  });

  it('does not label a cancelled navigation as a load failure', () => {
    const parameters = fixture(); const handlers = lifecycleHandlers();
    harness.mount(() => useWebviewLifecycle({ ...parameters, setRemountKey: vi.fn(), handlers }));
    parameters.emit('did-fail-load', { errorCode: -3, isMainFrame: true });
    expect(handlers.handleFailLoad).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an earlier navigation title timer and preserves normal page switching without reload', async () => {
    const parameters = fixture(); const mounted = harness.mount(() => useWebviewNavigation(parameters));
    await settleHooks(); vi.mocked(parameters.view.reload).mockClear();
    mounted.current.handleNavigate(Object.assign(new Event('did-navigate'), { url: 'https://fixture.test/previous' }));
    parameters.emit('did-start-navigation', { isMainFrame: true }); await vi.advanceTimersByTimeAsync(600);
    expect(parameters.view.executeJavaScript).not.toHaveBeenCalled(); expect(parameters.view.reload).not.toHaveBeenCalled();
  });

  it('does not write metadata from a stopped page after guest replacement', async () => {
    const parameters = fixture(); const pending = deferred<unknown>(); vi.mocked(parameters.view.executeJavaScript).mockReturnValue(pending.promise);
    const mounted = harness.mount(() => useWebviewLoadingProgress(parameters)); mounted.current.handleStopLoading();
    parameters.webviewRef.current = fixture().view; pending.resolve('Previous title'); await settleHooks();
    expect(state.store.updateTabTitle).not.toHaveBeenCalled(); expect(state.store.updateTabFavicon).not.toHaveBeenCalled();
    harness.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
