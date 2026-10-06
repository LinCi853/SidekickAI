import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaseWebviewLifecycle, matchesWebviewHotkeyTarget } from './webview-lifecycle';
import type { WebviewElement } from './webview';

function fixtureWebview() {
  const target = new EventTarget();
  const state = { id: 1, url: 'https://fixture.test/page' };
  const view = Object.assign(target, {
    getWebContentsId: () => state.id,
    getURL: () => state.url,
    addEventListener: vi.spyOn(target, 'addEventListener'),
    removeEventListener: vi.spyOn(target, 'removeEventListener'),
  }) as unknown as WebviewElement;
  const navigate = (isMainFrame = true) => view.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame }));
  return { view, state, navigate };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('webview page ownership', () => {
  it('keeps an already ready SPA document available to a replacement owner', () => {
    const { view } = fixtureWebview(); const first = leaseWebviewLifecycle(view); view.dispatchEvent(new Event('dom-ready'));
    view.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: true }));
    expect(first.isReady()).toBe(true);
    view.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { isMainFrame: true })); expect(first.isReady()).toBe(true);
    first.dispose(); const next = leaseWebviewLifecycle(view); expect(next.isReady()).toBe(true);
    view.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true })); expect(next.isReady()).toBe(false); next.dispose();
  });
  it('shares navigation listeners and releases only the disposing caller timers', () => {
    const { view } = fixtureWebview();
    const first = leaseWebviewLifecycle(view);
    const second = leaseWebviewLifecycle(view);
    expect(view.addEventListener).toHaveBeenCalledTimes(4);
    const retired = vi.fn();
    const current = vi.fn();
    first.delay(retired, 100);
    second.delay(current, 100);
    first.dispose();
    expect(view.removeEventListener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(retired).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
    second.dispose();
    expect(view.removeEventListener).toHaveBeenCalledTimes(4);
  });

  it('retires same URL navigation and cancels outstanding timers', () => {
    const { view, navigate } = fixtureWebview();
    const lease = leaseWebviewLifecycle(view);
    const page = lease.capture();
    const action = vi.fn();
    lease.delay(action, 100);
    navigate();
    expect(page.isCurrent()).toBe(false);
    expect(lease.capture().pageGeneration).toBeGreaterThan(page.pageGeneration);
    expect(vi.getTimerCount()).toBe(0);
    lease.dispose();
    vi.advanceTimersByTime(100);
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps subframe navigation within the same page ownership', () => {
    const { view, navigate } = fixtureWebview();
    const lease = leaseWebviewLifecycle(view);
    const page = lease.capture();
    navigate(false);
    expect(page.isCurrent()).toBe(true);
    lease.dispose();
  });

  it('rejects replaced elements, guest IDs and changed URLs', () => {
    const { view, state } = fixtureWebview();
    let current: WebviewElement | null = view;
    const lease = leaseWebviewLifecycle(view, () => current);
    const page = lease.capture();
    current = null;
    expect(page.isCurrent()).toBe(false);
    current = view;
    state.id = 2;
    expect(page.isCurrent()).toBe(false);
    state.id = 1;
    state.url = 'https://fixture.test/other';
    expect(page.isCurrent()).toBe(false);
    lease.dispose();
  });

  it('does not start new timers after an owner has been disposed', () => {
    const { view } = fixtureWebview();
    const lease = leaseWebviewLifecycle(view);
    const page = lease.capture();
    lease.dispose();
    lease.delay(vi.fn(), 100);
    expect(page.isCurrent()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires the requested guest, URL, profile and tab to match', () => {
    const { view, state } = fixtureWebview();
    const target = { webContentsId: state.id, documentGeneration: 2, url: state.url, tabId: 'tab', profileId: 'profile' };
    const expected = { tabId: 'tab', profileId: 'profile' };
    expect(matchesWebviewHotkeyTarget(view, target, expected)).toBe(true);
    for (const other of [{ ...target, webContentsId: 2 }, { ...target, url: 'https://fixture.test/other' },
      { ...target, tabId: 'other' }, { ...target, profileId: 'other' }]) {
      expect(matchesWebviewHotkeyTarget(view, other, expected)).toBe(false);
    }
  });
});
