import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WebviewElement } from '../lib/webview';
import { deferred, settleHooks } from '../hooks/draft-hook-test-harness';

const harness = await vi.hoisted(async () => (await import('../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ fingerprint: vi.fn(), inject: vi.fn(), cleanup: vi.fn(),
  profile: { id: 'profile', aiPlatformUrl: 'https://fixture.test/page' } as { id: string; aiPlatformUrl: string;
    isAIPlatform?: boolean; aiPlatformId?: string; aiInputSelector?: string; aiSendSelector?: string },
}));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../hooks/useHotkeys', () => ({ useHotkeys: vi.fn() }));
vi.mock('../hooks/useShortcutsToggle', () => ({ useShortcutsToggle: vi.fn() }));
vi.mock('../hooks/useIsNarrow', () => ({ useIsNarrow: () => false }));
vi.mock('../hooks/useEscToCloseWindow', () => ({ useEscToCloseWindow: vi.fn() }));
vi.mock('../components/WindowResizeHandles', () => ({ default: () => null }));
vi.mock('../components/SettingsPanel', () => ({ default: () => null }));
vi.mock('../components/ShortcutsModal', () => ({ default: () => null }));
vi.mock('../components/ui', () => ({ IconButton: () => null, TitleBar: () => null, PinToggleButton: () => null }));
vi.mock('../components/icons', () => ({ GearIcon: () => null }));
vi.mock('../store/useProfileStore', () => ({ useProfileStore: (selector: (value: unknown) => unknown) => selector({ profiles: [state.profile] }) }));
vi.mock('../store/useTabStore', () => ({ useTabStore: () => ({ tabs: [{ id: 'tab', profileId: 'profile', title: 'Fixture' }], activeTabId: 'tab', initialized: false }) }));
vi.mock('../lib/electron-api', () => ({ getFingerprintScript: state.fingerprint,
  listAIPlatforms: async () => [{ id: 'fixture', inputSelector: '#default-input', sendSelector: '#default-send' }],
}));
vi.mock('../lib/webview', () => ({ injectViewportAndPopupGuard: async () => {}, safeLoadURLWebview: vi.fn() }));
vi.mock('../lib/injection-manager', () => ({ injectionManager: { injectAll: state.inject, disposeWebview: state.cleanup } }));
vi.mock('../lib/electron-api/block-rules', () => ({ listBlockRules: vi.fn() }));
vi.mock('../lib/webview-blocker', () => ({ buildBlockerScript: vi.fn(), matchDomain: vi.fn() }));

import StandaloneView from './StandaloneView';

function mountView() {
  const view = Object.assign(new EventTarget(), { getWebContentsId: () => 1, getURL: () => 'https://fixture.test/page', executeJavaScript: vi.fn().mockResolvedValue(true) }) as unknown as WebviewElement;
  const attach = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const element = node as ReactElement<{ children?: unknown }> & { ref?: { current: unknown } };
    if (element.type === 'webview' && element.ref) element.ref.current = view;
    const children = element.props?.children;
    if (Array.isArray(children)) children.forEach(attach);
    else attach(children);
  };
  harness.mount(() => { const result = StandaloneView(); attach(result); return result; });
  return view;
}

beforeEach(() => {
  harness.reset(); vi.resetAllMocks(); vi.stubGlobal('document', { title: '' });
  state.profile = { id: 'profile', aiPlatformUrl: 'https://fixture.test/page' };
  state.inject.mockResolvedValue(undefined); state.cleanup.mockResolvedValue(undefined);
});
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); });

describe('standalone injection ownership', () => {
  it('manages Enter only for AI profiles and preserves their selector overrides', async () => {
    state.profile = { ...state.profile, isAIPlatform: true, aiPlatformId: 'fixture', aiInputSelector: '#account-input' };
    state.fingerprint.mockResolvedValue('fingerprint'); const view = mountView();
    view.dispatchEvent(new Event('dom-ready')); await settleHooks();
    expect(state.inject.mock.calls[0][3]).toMatchObject({ manageEnterToSend: true,
      inputSelector: '#account-input', sendSelector: '#default-send', profile: state.profile });
  });

  it('retires a delayed fingerprint and injection binding when closing', async () => {
    const pending = deferred<string>(); state.fingerprint.mockReturnValue(pending.promise); const view = mountView();
    view.dispatchEvent(new Event('dom-ready')); harness.unmount(); pending.resolve('old'); await settleHooks();
    expect(view.executeJavaScript).not.toHaveBeenCalled(); expect(state.inject).not.toHaveBeenCalled();
    expect(state.cleanup).toHaveBeenCalledWith('standalone-profile', view);
  });

  it('keeps the current identity on successful injection', async () => {
    state.fingerprint.mockResolvedValue('fingerprint'); const view = mountView(); view.dispatchEvent(new Event('dom-ready')); await settleHooks();
    expect(state.inject).toHaveBeenCalledWith('standalone-profile', view, 'https://fixture.test/page', expect.objectContaining({ tabId: 'tab', profileId: 'profile' }));
    expect(state.inject.mock.calls[0][3]).not.toHaveProperty('manageEnterToSend');
    const previous = state.inject.mock.calls[0][3];
    view.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { isMainFrame: true })); await settleHooks();
    const current = state.inject.mock.calls[1][3];
    expect(current.pageGeneration).toBeGreaterThan(previous.pageGeneration); expect(previous.isCurrent()).toBe(false); expect(current.isCurrent()).toBe(true);
  });
});
