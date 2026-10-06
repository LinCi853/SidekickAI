import type { WebviewHotkeyTarget } from '../../electron/shared/types';
import type { WebviewElement } from './webview';

export interface WebviewPageSnapshot {
  pageGeneration: number;
  url: string;
  isCurrent: () => boolean;
}

export interface WebviewLifecycleLease {
  capture: () => WebviewPageSnapshot;
  isReady: () => boolean;
  delay: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout> | undefined;
  cancelTimers: () => void;
  dispose: () => void;
}

interface PageTracker {
  generation: number;
  ready: boolean;
  readyGuestId?: number;
  readyUrl?: string;
  leases: Set<() => void>;
  invalidate: EventListener;
}

const trackers = new WeakMap<WebviewElement, PageTracker>();
const navigationEvents = ['did-start-navigation', 'did-navigate-in-page', 'render-process-gone', 'dom-ready'];

function guestId(webview: WebviewElement): number | undefined {
  try { return webview.getWebContentsId(); } catch { return undefined; }
}

function pageUrl(webview: WebviewElement): string {
  try { return webview.getURL(); } catch { return ''; }
}

/** Shares document identity listeners while keeping each caller's timers and release independent. */
export function leaseWebviewLifecycle(
  webview: WebviewElement,
  currentWebview: () => WebviewElement | null = () => webview,
): WebviewLifecycleLease {
  let tracker = trackers.get(webview);
  if (!tracker) {
    tracker = { generation: 0, ready: false, leases: new Set(), invalidate: () => {} };
    const page = tracker;
    page.invalidate = (event) => {
      if (event.type === 'dom-ready') {
        page.ready = true;
        page.readyGuestId = guestId(webview);
        page.readyUrl = pageUrl(webview);
        return;
      }
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
      if (event.type === 'did-navigate-in-page') {
        if (page.ready) {
          page.readyGuestId = guestId(webview);
          page.readyUrl = pageUrl(webview);
        }
      } else if (event.type !== 'did-start-navigation' || (event as Event & { isInPlace?: boolean }).isInPlace !== true) {
        page.ready = false;
      }
      page.generation += 1;
      page.leases.forEach(cancel => cancel());
    };
    trackers.set(webview, tracker);
  }
  const page = tracker;
  if (page.leases.size === 0) {
    navigationEvents.forEach(event => webview.addEventListener(event, page.invalidate));
  }
  let active = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const cancelTimers = () => {
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
  };
  page.leases.add(cancelTimers);

  const capture = (): WebviewPageSnapshot => {
    const generation = page.generation;
    const id = guestId(webview);
    const url = pageUrl(webview);
    return {
      pageGeneration: generation,
      url,
      isCurrent: () => active && page.generation === generation && currentWebview() === webview
        && webview.isConnected !== false && guestId(webview) === id && pageUrl(webview) === url,
    };
  };

  return {
    capture,
    isReady: () => active && page.ready && currentWebview() === webview && webview.isConnected !== false
      && guestId(webview) === page.readyGuestId && pageUrl(webview) === page.readyUrl,
    delay(callback, milliseconds) {
      const snapshot = capture();
      if (!snapshot.isCurrent()) return undefined;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (snapshot.isCurrent()) callback();
      }, milliseconds);
      timers.add(timer);
      return timer;
    },
    cancelTimers,
    dispose() {
      if (!active) return;
      active = false;
      cancelTimers();
      page.leases.delete(cancelTimers);
      if (page.leases.size === 0) {
        page.generation += 1;
        navigationEvents.forEach(event => webview.removeEventListener(event, page.invalidate));
      }
    },
  };
}

export function matchesWebviewHotkeyTarget(
  webview: WebviewElement,
  target: WebviewHotkeyTarget,
  expected: { tabId: string; profileId: string },
): boolean {
  return webview.isConnected !== false && guestId(webview) === target.webContentsId
    && pageUrl(webview) === target.url
    && (target.tabId === undefined || target.tabId === expected.tabId)
    && (target.profileId === undefined || target.profileId === expected.profileId);
}
