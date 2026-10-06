import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';
import { deferred, settleHooks } from '../../../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../../../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({
  fingerprint: vi.fn(), fallback: vi.fn(), history: vi.fn(), load: vi.fn(), inject: vi.fn(), cleanup: vi.fn(), login: vi.fn(),
  tabStore: { tabs: [{ id: 'tab', url: 'https://fixture.test/latest' }], updateTabUrl: vi.fn(), toggleBottomBar: vi.fn() },
}));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../../lib/electron-api', () => ({ getFingerprintScript: state.fingerprint, applyProxyFallback: state.fallback,
  recordNavHistory: state.history, logLoginTrace: state.login }));
vi.mock('../../../lib/webview', () => ({ sanitizeUrl: (value: string) => value, safeLoadURLWebview: state.load, injectViewportAndPopupGuard: async () => {} }));
vi.mock('../../../lib/injection-manager', () => ({ injectionManager: { injectAll: state.inject, disposeWebview: state.cleanup } }));
vi.mock('../../../store/useTabStore', () => ({ useTabStore: { getState: () => state.tabStore } }));
vi.mock('../scripts', () => ({ DETECT_LOGIN_SCRIPT: 'login', buildEnterToSendScript: () => 'enter' }));

import { useWebviewInjection } from './useWebviewInjection';
import { useWebviewRemount } from './useWebviewRemount';
import { useWebviewLifecycleEvents } from './useWebviewLifecycleEvents';

function webviewFixture() {
  const target = new EventTarget();
  const view = Object.assign(target, { getWebContentsId: () => 1, getURL: () => 'https://fixture.test/page',
    addEventListener: vi.spyOn(target, 'addEventListener'),
    executeJavaScript: vi.fn().mockResolvedValue(false), reload: vi.fn(), canGoBack: () => false, canGoForward: () => false }) as unknown as WebviewElement;
  const emit = (event: string, details = {}) => view.dispatchEvent(Object.assign(new Event(event, { cancelable: true }), details));
  return { view, ref: { current: view as WebviewElement | null }, emit };
}

function mountInjection(ref: { current: WebviewElement | null }, profile: Profile = { id: 'profile' } as Profile) {
  return harness.mount(() => useWebviewInjection({ webviewRef: ref, tab: { id: 'tab' }, profile, remountKey: 0,
    domReadyRef: { current: false }, onDomReadyChangeRef: { current: undefined },
    onNavigationChangeRef: { current: undefined }, resetRemountFailState: vi.fn(), loggedLoginUrlsRef: { current: new Set() },
    lastLoginCheckedUrlRef: { current: '' } }));
}

function mountEvents(ref: { current: WebviewElement | null }, triggerRemount = vi.fn()) {
  harness.mount(() => useWebviewLifecycleEvents({ webviewRef: ref, tab: { id: 'tab', url: 'https://fixture.test/initial' },
    profile: { id: 'profile' } as Profile, triggerRemount, remountKey: 0,
    onNavigationChangeRef: { current: undefined }, onProcessGoneRef: { current: undefined } }));
  return triggerRemount;
}

beforeEach(() => {
  harness.reset(); vi.useFakeTimers(); vi.resetAllMocks();
  state.fingerprint.mockResolvedValue('fingerprint'); state.inject.mockResolvedValue(undefined); state.cleanup.mockResolvedValue(undefined);
  state.fallback.mockResolvedValue({ switched: true, mode: 'direct' }); state.history.mockResolvedValue(undefined);
});
afterEach(() => { harness.unmount(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('main webview delayed work', () => {
  it('rebinds enhancement and Enter ownership on SPA navigation without reloading the document', async () => {
    const { view, ref, emit } = webviewFixture(); mountInjection(ref); emit('dom-ready'); await settleHooks();
    const previous = state.inject.mock.calls[0][3];
    emit('did-navigate-in-page', { isMainFrame: true }); await settleHooks();
    const current = state.inject.mock.calls[1][3];
    expect(current).toMatchObject({ profileId: 'profile', tabId: 'tab', manageEnterToSend: true });
    expect(current.pageGeneration).toBeGreaterThan(previous.pageGeneration);
    expect(previous.isCurrent()).toBe(false); expect(current.isCurrent()).toBe(true);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(1); expect(view.reload).not.toHaveBeenCalled();
  });
  it.each(['unmount', 'navigation', 'replacement'] as const)('does not inject a fingerprint after %s', async change => {
    const { view, ref, emit } = webviewFixture();
    const pending = deferred<string>(); state.fingerprint.mockReturnValue(pending.promise);
    mountInjection(ref); emit('dom-ready');
    if (change === 'unmount') harness.unmount();
    else if (change === 'navigation') emit('did-start-navigation', { isMainFrame: true });
    else ref.current = webviewFixture().view;
    pending.resolve('old'); await settleHooks();
    expect(view.executeJavaScript).not.toHaveBeenCalled(); expect(state.inject).not.toHaveBeenCalled();
  });

  it('stops the injection pipeline when a completed script belongs to the previous page', async () => {
    const { view, ref, emit } = webviewFixture(); const pending = deferred<unknown>();
    vi.mocked(view.executeJavaScript).mockReturnValueOnce(pending.promise);
    mountInjection(ref); emit('dom-ready'); await settleHooks();
    emit('did-start-navigation', { isMainFrame: true }); pending.resolve(true); await settleHooks();
    expect(view.executeJavaScript).toHaveBeenCalledTimes(1); expect(state.inject).not.toHaveBeenCalled();
  });

  it('cancels the login check timer on disposal', async () => {
    const { view, ref, emit } = webviewFixture(); mountInjection(ref, { id: 'profile', isAIPlatform: true } as Profile);
    emit('dom-ready'); await settleHooks(); harness.unmount();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(4000);
    expect(view.executeJavaScript).not.toHaveBeenCalledWith('login'); expect(state.cleanup).toHaveBeenCalledWith('tab', view);
  });

  it('deduplicates reload requests while the initial streaming check is unresolved', async () => {
    const { view } = webviewFixture(); const pending = deferred<boolean>();
    vi.mocked(view.executeJavaScript).mockReturnValue(pending.promise);
    const mounted = harness.mount(() => useWebviewRemount({ tab: { id: 'tab' }, profile: { id: 'profile' } as Profile }));
    mounted.current.scheduleReload(view); mounted.current.scheduleReload(view);
    expect(view.executeJavaScript).toHaveBeenCalledOnce(); pending.resolve(false); await settleHooks();
    expect(view.reload).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create reload timers after the hook has been unmounted', async () => {
    const { view } = webviewFixture(); const pending = deferred<boolean>(); vi.mocked(view.executeJavaScript).mockReturnValue(pending.promise);
    const mounted = harness.mount(() => useWebviewRemount({ tab: { id: 'tab' }, profile: { id: 'profile' } as Profile }));
    mounted.current.scheduleReload(view); harness.unmount(); pending.resolve(true); await settleHooks();
    expect(view.reload).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('releases delayed streaming reloads on navigation and accepts a fresh page request', async () => {
    const { view, emit } = webviewFixture(); vi.mocked(view.executeJavaScript).mockResolvedValueOnce(true).mockResolvedValue(false);
    const mounted = harness.mount(() => useWebviewRemount({ tab: { id: 'tab' }, profile: { id: 'profile' } as Profile }));
    mounted.current.scheduleReload(view); await settleHooks(); expect(vi.getTimerCount()).toBe(2);
    emit('did-start-navigation', { isMainFrame: true }); expect(vi.getTimerCount()).toBe(0);
    mounted.current.scheduleReload(view); await settleHooks(); expect(view.reload).toHaveBeenCalledOnce();
  });

  it('cancels proxy and long press timers when event ownership is released', async () => {
    const { view, ref, emit } = webviewFixture(); mountEvents(ref);
    emit('did-fail-load', { errorCode: -130, isMainFrame: true, validatedURL: 'https://fixture.test/old' });
    const listener = vi.mocked(view.addEventListener).mock.calls.find(([event]) => event === 'before-input-event')?.[1] as EventListener;
    listener({ type: 'keyDown', key: 'Tab', modifiers: [], isAutoRepeat: false, preventDefault() {} } as unknown as Event);
    harness.unmount(); expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(2000);
    expect(view.executeJavaScript).not.toHaveBeenCalled(); expect(state.fallback).not.toHaveBeenCalled();
    expect(state.tabStore.toggleBottomBar).not.toHaveBeenCalled();
  });

  it('ignores a proxy blank page result after same URL navigation', async () => {
    const { view, ref, emit } = webviewFixture(); const pending = deferred<unknown>();
    vi.mocked(view.executeJavaScript).mockReturnValue(pending.promise); mountEvents(ref);
    emit('did-fail-load', { errorCode: -130, isMainFrame: true }); await vi.advanceTimersByTimeAsync(1500);
    emit('did-start-navigation', { isMainFrame: true }); pending.resolve({ textLen: 0, childCount: 0, htmlLen: 0 }); await settleHooks();
    expect(state.fallback).not.toHaveBeenCalled(); expect(state.load).not.toHaveBeenCalled();
  });

  it('keeps normal navigation and uses the current URL for crash recovery', () => {
    const { ref, emit } = webviewFixture(); const recover = mountEvents(ref);
    emit('did-navigate', { url: 'https://fixture.test/next' }); expect(recover).not.toHaveBeenCalled();
    emit('render-process-gone', { reason: 'crashed' });
    expect(recover).toHaveBeenCalledWith('https://fixture.test/latest', 'render-process-gone(crashed)', false);
  });
});
