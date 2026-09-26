import { describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from '../hooks/draft-hook-test-harness';
import { createWhiteboardDraft } from './whiteboard-draft';

function fixture() {
  const save = vi.fn().mockResolvedValue({ ok: true });
  const saveSync = vi.fn().mockReturnValue({ ok: true });
  const draft = createWhiteboardDraft<string>({ serialize: (scene) => scene, save, saveSync });
  return { draft, save, saveSync };
}

describe('whiteboard revision writer', () => {
  it('retains the latest scene after rejection and retries it', async () => {
    const { draft, save } = fixture();
    draft.update('unsaved');
    save.mockRejectedValueOnce(new Error('SQLITE_FULL fixture'));
    await expect(draft.flush()).rejects.toThrow('SQLITE_FULL');
    draft.update('newer unsaved');
    await draft.flush();
    expect(save.mock.calls.map(([scene]) => scene)).toEqual(['unsaved', 'newer unsaved']);
    await draft.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('treats resolved ok:false as a failure, including the synchronous path', async () => {
    const { draft, save, saveSync } = fixture();
    draft.update('must survive');
    save.mockResolvedValueOnce({ ok: false });
    await expect(draft.flush()).rejects.toThrow('Whiteboard save failed');
    saveSync.mockReturnValueOnce({ ok: false });
    expect(() => draft.flushSync()).toThrow('Whiteboard save failed');
    draft.flushSync();
    expect(saveSync).toHaveBeenLastCalledWith('must survive');
  });

  it('serializes writes and drains edits made during the old write before releasing navigation', async () => {
    const { draft, save } = fixture();
    const old = deferred<{ ok: boolean }>();
    const latest = deferred<{ ok: boolean }>();
    save.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    draft.update('old');
    const navigation = draft.flush();
    const complete = vi.fn();
    void navigation.then(complete);
    await settleHooks();
    draft.update('latest');
    expect(draft.flush()).toBe(navigation);
    expect(save).toHaveBeenCalledTimes(1);
    old.resolve({ ok: true });
    await settleHooks();
    expect(save.mock.calls.map(([scene]) => scene)).toEqual(['old', 'latest']);
    expect(complete).not.toHaveBeenCalled();
    latest.resolve({ ok: true });
    await navigation;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('never starts a newer sync write while an old asynchronous writer can arrive late', async () => {
    const { draft, save, saveSync } = fixture();
    const old = deferred<{ ok: boolean }>();
    save.mockReturnValueOnce(old.promise);
    draft.update('old');
    const pending = draft.flush();
    await settleHooks();
    draft.update('latest');
    expect(() => draft.flushSync()).toThrow('still in progress');
    expect(saveSync).not.toHaveBeenCalled();
    old.resolve({ ok: true });
    await pending;
    draft.flushSync();
    expect(save).toHaveBeenLastCalledWith('latest');
    expect(saveSync).not.toHaveBeenCalled();
  });

  it('does not clear a newer failed revision when an older version succeeds', async () => {
    const { draft, save } = fixture();
    const old = deferred<{ ok: boolean }>();
    save.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: false });
    draft.update('old');
    const pending = draft.flush();
    const failure = expect(pending).rejects.toThrow('Whiteboard save failed');
    await settleHooks();
    draft.update('latest');
    old.resolve({ ok: true });
    await failure;
    await draft.flush();
    expect(save.mock.calls.map(([scene]) => scene)).toEqual(['old', 'latest', 'latest']);
  });

  it('propagates serializer exceptions and preserves the revision for retry', async () => {
    const serialize = vi.fn().mockImplementationOnce(() => { throw new Error('serialization fixture'); }).mockReturnValue('scene');
    const save = vi.fn().mockResolvedValue({ ok: true });
    const draft = createWhiteboardDraft({ serialize, save, saveSync: () => ({ ok: true }) });
    draft.update('scene');
    await expect(draft.flush()).rejects.toThrow('serialization fixture');
    await draft.flush();
    expect(save).toHaveBeenCalledWith('scene');
  });
});
