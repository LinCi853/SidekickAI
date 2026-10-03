import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HotkeyConfig, PromptTemplate } from '../lib/electron-api';
import { deferred, settleHooks } from './draft-hook-test-harness';
const harness = await vi.hoisted(async () => (await import('./draft-hook-test-harness')).createHookHarness());
const state = vi.hoisted(() => ({ prompts: [] as PromptTemplate[], listeners: [] as Array<() => void>, hotkeys: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...harness.react }));
vi.mock('../store/usePromptStore', () => ({ usePromptStore: { getState: () => ({ prompts: state.prompts }), subscribe: (listener: () => void) => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter(item => item !== listener); }; } } }));
vi.mock('../lib/electron-api', () => ({ getHotkeys: state.hotkeys }));
vi.mock('../lib/shared-utils', () => ({ isTypingTarget: () => false }));
import { usePromptHotkeys } from './usePromptHotkeys';

const general: PromptTemplate = { id: 'prompt', title: 'General', content: 'General text', hotkey: 'Ctrl+Shift+P', createdAt: 1, updatedAt: 1 };
function press() {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, { key: { value: 'P' }, ctrlKey: { value: true }, shiftKey: { value: true } });
  window.dispatchEvent(event); return event;
}
beforeEach(() => { harness.reset(); vi.resetAllMocks(); state.listeners = []; state.prompts = [general]; });
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); });
describe('prompt hotkey current content', () => {
  it('ignores obsolete hotkey reads and immediately refuses an example-only current template', async () => {
    const oldRead = deferred<HotkeyConfig[]>(); const newRead = deferred<HotkeyConfig[]>();
    state.hotkeys.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const triggered = vi.fn(); harness.mount(() => usePromptHotkeys({ onTriggered: triggered })); await settleHooks();
    state.prompts = [{ ...general, content: '', example: { content: 'Snapshot' } }]; state.listeners.forEach(listener => listener());
    newRead.resolve([]); await settleHooks(); oldRead.resolve([]); await settleHooks();
    expect(press().defaultPrevented).toBe(false); expect(triggered).not.toHaveBeenCalled();
    state.hotkeys.mockResolvedValue([]); state.prompts = [general]; state.listeners.forEach(listener => listener()); await settleHooks();
    expect(press().defaultPrevented).toBe(true); expect(triggered).toHaveBeenCalledWith(general, { skipPreview: false });
    state.prompts = [{ ...general, content: ' ' }];
    press(); expect(triggered).toHaveBeenCalledOnce();
  });

  it('allows a general template to reuse an example-only template accelerator', async () => {
    state.prompts = [{ ...general, id: 'example', content: '', example: { content: 'Snapshot' } }, general]; state.hotkeys.mockResolvedValue([]);
    const triggered = vi.fn(); harness.mount(() => usePromptHotkeys({ onTriggered: triggered })); await settleHooks();
    press(); expect(triggered).toHaveBeenCalledWith(general, { skipPreview: false });
  });
});
