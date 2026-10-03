import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptTemplate } from '../../../lib/electron-api';
import { settleHooks } from '../../../hooks/draft-hook-test-harness';
const harness = await vi.hoisted(async () => (await import('../../../hooks/draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ inject: vi.fn(), log: vi.fn(), result: vi.fn(), similar: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../../../hooks/useWebViewControl', () => ({ injectTextToWebview: state.inject }));
vi.mock('../../../hooks/usePromptHotkeys', () => ({ usePromptHotkeys: vi.fn() }));
vi.mock('../../../lib/electron-api', () => ({ findSimilarInjection: state.similar, logInjection: state.log, onPromptInjectRequest: () => () => {}, sendPromptInjectResult: state.result }));
import { usePromptInjection } from './usePromptInjection';
const exampleOnly: PromptTemplate = { id: 'example', title: 'Example', content: ' ', example: { content: 'Private snapshot' }, createdAt: 1, updatedAt: 1 };
beforeEach(() => { harness.reset(); vi.resetAllMocks(); });
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); });
describe('main prompt content boundary', () => {
  it('rejects example-only calls before reading a webview or creating a preview', async () => {
    const query = vi.fn(); vi.stubGlobal('document', { querySelector: query });
    const view = harness.mount(() => usePromptInjection({ id: 'tab', profileId: 'profile' }, () => null, [])); await settleHooks();
    expect(await view.current.handleInjectPrompt(exampleOnly, 'detached', true)).toEqual({ success: false });
    expect(query).not.toHaveBeenCalled(); expect(state.inject).not.toHaveBeenCalled(); expect(state.log).not.toHaveBeenCalled();
    expect(state.result).toHaveBeenCalledWith({ success: false }); expect(view.current.previewState.open).toBe(false);
  });

  it('uses general text with body placeholders while ignoring its example snapshot', async () => {
    const webview = { executeJavaScript: vi.fn().mockResolvedValue('Existing input') };
    vi.stubGlobal('document', { querySelector: () => webview }); state.inject.mockResolvedValue(true); state.log.mockResolvedValue(undefined);
    const general = { ...exampleOnly, content: 'General {{body}}' };
    const view = harness.mount(() => usePromptInjection({ id: 'tab', profileId: 'profile' }, () => null, [])); await settleHooks();
    expect(await view.current.handleInjectPrompt(general, 'inline', true)).toEqual({ success: true, platformName: undefined });
    expect(state.inject).toHaveBeenCalledWith(webview, 'General Existing input', null);
    expect(state.log).toHaveBeenCalledWith(expect.objectContaining({ composedText: 'General Existing input' }));
  });
});
