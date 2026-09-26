import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleHooks } from './draft-hook-test-harness.js';

const harness = await vi.hoisted(async () => {
  const { createHookHarness } = await import('./draft-hook-test-harness.js');
  return createHookHarness();
});
vi.mock('react', () => harness.react);
import { useAutoSaveDraft } from './useAutoSaveDraft.js';

beforeEach(() => {
  vi.useFakeTimers();
  harness.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  harness.unmount();
  await settleHooks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('automatic draft save errors', () => {
  it('handles rejected background saves but keeps explicit flush rejection observable', async () => {
    const failure = new Error('Save unavailable');
    const save = vi.fn().mockRejectedValue(failure);
    const hook = harness.mount(() => useAutoSaveDraft({ data: 'draft', save }));
    hook.current.schedule();
    await vi.advanceTimersByTimeAsync(800);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[AutoSave]'), failure);
    await expect(hook.current.flushNow()).rejects.toBe(failure);
  });

  it('handles a synchronous background throw and exposes it as a rejected flush promise', async () => {
    const failure = new Error('Save unavailable');
    const save = vi.fn(() => { throw failure; });
    const hook = harness.mount(() => useAutoSaveDraft({ data: 'draft', save }));
    hook.current.schedule();
    await expect(vi.advanceTimersByTimeAsync(800)).resolves.toBeDefined();
    await expect(hook.current.flushNow()).rejects.toBe(failure);
  });

  it('handles rejected saves during unmount', async () => {
    const failure = new Error('Save unavailable');
    harness.mount(() => useAutoSaveDraft({ data: 'draft', save: vi.fn().mockRejectedValue(failure) }));
    harness.unmount();
    await settleHooks();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[AutoSave]'), failure);
  });

  it('notifies callers about both asynchronous and synchronous failures', async () => {
    const failure = new Error('Save unavailable');
    const onError = vi.fn();
    const hook = harness.mount(() => useAutoSaveDraft({
      data: 'draft', save: vi.fn().mockRejectedValue(failure),
      saveSync: () => { throw failure; }, onError,
    }));
    await expect(hook.current.flushNow()).rejects.toBe(failure);
    expect(onError).toHaveBeenLastCalledWith(failure);
    const event = new Event('sidekick:before-handoff', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('still vetoes unload if the error notification callback throws', () => {
    harness.mount(() => useAutoSaveDraft({
      data: 'draft', save: () => {},
      saveSync: () => { throw new Error('Disk full'); },
      onError: () => { throw new Error('Notification failed'); },
    }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('vetoes failed synchronous handoff and permits retry with the current data', async () => {
    let data = 'first';
    const saveSync = vi.fn().mockImplementationOnce(() => { throw new Error('Disk full'); });
    const hook = harness.mount(() => useAutoSaveDraft({ data, save: vi.fn(), saveSync }));
    const first = new Event('sidekick:before-handoff', { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    data = 'latest';
    harness.mount(() => useAutoSaveDraft({ data, save: vi.fn(), saveSync }));
    const retry = new Event('sidekick:before-handoff', { cancelable: true });
    window.dispatchEvent(retry);
    expect(retry.defaultPrevented).toBe(false);
    expect(saveSync).toHaveBeenLastCalledWith('latest');
    await hook.current.flushNow();
  });
});
