import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleHooks } from './draft-hook-test-harness';

const harness = await vi.hoisted(async () => {
  const { createHookHarness } = await import('./draft-hook-test-harness');
  return createHookHarness();
});
vi.mock('react', () => harness.react);
import { useToast } from './useToast';

beforeEach(() => {
  vi.useFakeTimers();
  harness.reset();
});
afterEach(() => {
  harness.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([2500, 3000])('feedback duration %i', duration => {
  it('keeps the message visible until its configured deadline', async () => {
    const hook = harness.mount(() => useToast(duration));
    expect(hook.current.toast).toBeFalsy();
    hook.current.showToast('Saved');
    await settleHooks();
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(hook.current.toast).toBe('Saved');
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.current.toast).toBeFalsy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('replaces the message and restarts the full deadline', async () => {
    const hook = harness.mount(() => useToast(duration));
    hook.current.showToast('Older');
    await vi.advanceTimersByTimeAsync(duration - 1);
    hook.current.showToast('Latest');
    await vi.advanceTimersByTimeAsync(1);
    expect(hook.current.toast).toBe('Latest');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(hook.current.toast).toBeFalsy();
  });
  it('clears pending feedback before another operation', async () => {
    const hook = harness.mount(() => useToast(duration));
    hook.current.showToast('Previous result');
    await settleHooks();
    hook.current.clearToast();
    await settleHooks();
    expect(hook.current.toast).toBeFalsy();
    expect(vi.getTimerCount()).toBe(0);
    hook.current.showToast('New result');
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(hook.current.toast).toBe('New result');
  });
  it('cancels a pending timer when its consumer unmounts', async () => {
    const hook = harness.mount(() => useToast(duration));
    hook.current.showToast('Saved');
    await settleHooks();
    expect(vi.getTimerCount()).toBe(1);
    harness.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
