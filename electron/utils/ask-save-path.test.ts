import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeAskSavePath, markAskSavePath } from './ask-save-path';

const url = 'https://fixture.test/original';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('explicit download save intents', () => {
  it('does not let another profile session consume a requested save', () => {
    const requested = {} as Session;
    const unrelated = {} as Session;
    markAskSavePath(requested, url);
    expect(consumeAskSavePath(unrelated, url)).toBe(false);
    expect(consumeAskSavePath(requested, url)).toBe(true);
  });

  it('matches the exact requested URL within the same session', () => {
    const session = {} as Session;
    markAskSavePath(session, url);
    expect(consumeAskSavePath(session, `${url}?ordinary=1`)).toBe(false);
    expect(consumeAskSavePath(session, url)).toBe(true);
    expect(consumeAskSavePath(session, url)).toBe(false);
  });

  it('consumes repeated requests once each and can cancel only one request', () => {
    const session = {} as Session;
    const cancel = markAskSavePath(session, url);
    markAskSavePath(session, url);
    cancel(); cancel();
    expect(consumeAskSavePath(session, url)).toBe(true);
    expect(consumeAskSavePath(session, url)).toBe(false);
  });

  it('releases a stale request before a later ordinary download arrives', () => {
    const session = {} as Session;
    markAskSavePath(session, url);
    vi.advanceTimersByTime(60001);
    expect(consumeAskSavePath(session, url)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a completed request cancel a newer request for that session', () => {
    const session = {} as Session;
    const cancelOld = markAskSavePath(session, url);
    expect(consumeAskSavePath(session, url)).toBe(true);
    markAskSavePath(session, url);
    cancelOld();
    expect(consumeAskSavePath(session, url)).toBe(true);
  });
});
