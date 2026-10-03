import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from './draft-hook-test-harness.js';

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
  it('writes the latest queued revision even if its predecessor fails while retaining navigation failure', async () => {
    const first = deferred<void>();
    const failure = new Error('Older write failed');
    let data = 'older';
    let stored = '';
    const save = vi.fn(async (value: string) => {
      if (value === 'older') await first.promise;
      stored = value;
    });
    const hook = harness.mount(() => useAutoSaveDraft({ data, save }));
    const older = hook.current.flushNow();
    const olderFailure = expect(older).rejects.toBe(failure);
    data = 'latest';
    harness.mount(() => useAutoSaveDraft({ data, save }));
    const latest = hook.current.flushNow();
    const navigationFailure = expect(latest).rejects.toBe(failure);
    first.reject(failure);
    await Promise.all([olderFailure, navigationFailure]);
    expect(stored).toBe('latest');
    expect(save.mock.calls.map(call => call[0])).toEqual(['older', 'latest']);
  });
  it('saves the latest handoff revision after an earlier ordinary write fails without showing its error', async () => {
    const first = deferred<void>();
    const failure = new Error('Older write failed');
    let data = 'older';
    let stored = '';
    const save = vi.fn(async (value: string) => {
      if (value === 'older') await first.promise;
      stored = value;
    });
    const onError = vi.fn();
    const hook = harness.mount(() => useAutoSaveDraft({ data, save, onError }));
    const older = hook.current.flushNow();
    const olderFailure = expect(older).rejects.toBe(failure);
    data = 'latest';
    harness.mount(() => useAutoSaveDraft({ data, save, onError }));
    const waiting: Promise<unknown>[] = [];
    window.dispatchEvent(Object.assign(new Event('sidekick:before-handoff', { cancelable: true }), {
      detail: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise), suppressPrompts: true },
    }));
    first.reject(failure);
    await olderFailure;
    await Promise.all(waiting);
    expect(stored).toBe('latest');
    expect(onError).not.toHaveBeenCalled();
  });
  it('keeps handoff failures quiet and restores normal save reporting after cancellation', async () => {
    const failure = new Error('Disk unavailable');
    const onError = vi.fn();
    const save = vi.fn().mockRejectedValue(failure);
    const hook = harness.mount(() => useAutoSaveDraft({ data: 'draft', save, onError }));
    const waiting: Promise<unknown>[] = [];
    const event = Object.assign(new Event('sidekick:before-handoff', { cancelable: true }), {
      detail: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise), suppressPrompts: true },
    });
    window.dispatchEvent(event);
    const saved = Promise.allSettled(waiting);
    window.dispatchEvent(new Event('sidekick:cancel-handoff'));
    expect((await saved)[0].status).toBe('rejected');
    expect(onError).not.toHaveBeenCalled();
    await expect(hook.current.flushNow()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);
  });
  it('restores a synchronous unload revision after an older asynchronous writer completes', async () => {
    const older = deferred<void>();
    let data = 'older';
    let stored = '';
    const save = async (value: string) => { await older.promise; stored = value; };
    const saveSync = (value: string) => { stored = value; };
    const hook = harness.mount(() => useAutoSaveDraft({ data, save, saveSync }));
    const writing = hook.current.flushNow();
    data = 'latest';
    harness.mount(() => useAutoSaveDraft({ data, save, saveSync }));
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(stored).toBe('latest');
    older.resolve();
    await writing;
    expect(stored).toBe('latest');
  });
  it('registers an awaited handoff save rather than synchronously rejecting an in-flight save', async () => {
    const write = deferred<void>();
    const save = vi.fn(() => write.promise);
    const saveSync = vi.fn(() => { throw new Error('Write pending'); });
    harness.mount(() => useAutoSaveDraft({ data: 'latest', save, saveSync }));
    const waiting: Promise<unknown>[] = [];
    const event = Object.assign(new Event('sidekick:before-handoff', { cancelable: true }), {
      detail: { waitUntil: (promise: Promise<unknown>) => waiting.push(promise), suppressPrompts: true },
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(waiting).toHaveLength(1);
    await settleHooks();
    expect(save).toHaveBeenCalledWith('latest');
    expect(saveSync).not.toHaveBeenCalled();
    write.resolve();
    await Promise.all(waiting);
  });

  it('serializes draft writes and leaves the newest requested revision last', async () => {
    const first = deferred<void>();
    let data = 'first';
    let stored = '';
    const save = vi.fn(async (value: string) => {
      if (value === 'first') await first.promise;
      stored = value;
    });
    const hook = harness.mount(() => useAutoSaveDraft({ data, save }));
    const older = hook.current.flushNow();
    await settleHooks();
    data = 'latest';
    harness.mount(() => useAutoSaveDraft({ data, save }));
    const latest = hook.current.flushNow();
    await settleHooks();
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([older, latest]);
    expect(stored).toBe('latest');
  });

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
