import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, NoteSaveInput } from '../../../electron/shared/types.js';
import { deferred, settleHooks } from '../../hooks/draft-hook-test-harness.js';

const harness = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../hooks/draft-hook-test-harness.js');
  return createHookHarness();
});
const api = vi.hoisted(() => ({
  listNotes: vi.fn(), saveNote: vi.fn(), saveNoteSync: vi.fn(), deleteNote: vi.fn(),
  getActiveNote: vi.fn(), setActiveNote: vi.fn(), setNotePinned: vi.fn(), setNoteTags: vi.fn(),
  listNoteTags: vi.fn(), sendNoteToAi: vi.fn(), onNoteInjectResult: vi.fn(),
}));
vi.mock('react', () => harness.react);
vi.mock('../../lib/electron-api/notes.js', () => api);
vi.mock('../../lib/electron-api/settings.js', () => ({
  getAppSettings: async () => ({}), updateAppSettings: async () => ({}),
}));
import { useNotesData } from './useNotesData.js';

const original: Note = {
  id: 'existing', title: 'Original', content: 'Original', contentJson: '{}',
  pinned: false, tags: [], createdAt: 1, updatedAt: 1,
};
const other: Note = { ...original, id: 'other', title: 'Other', content: 'Other' };
let rows: Map<string, Note>;
let generatedId: number;
function persist(input: NoteSaveInput): Note {
  const id = input.id || `generated-${++generatedId}`;
  const note = { ...original, ...rows.get(id), ...input, id, updatedAt: Date.now() };
  rows.set(id, note);
  return note;
}
async function mountNotes() {
  const hook = harness.mount(useNotesData);
  await settleHooks();
  return hook;
}
function handoff() {
  const event = new Event('sidekick:before-handoff', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  harness.reset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rows = new Map([[original.id, original], [other.id, other]]);
  generatedId = 0;
  api.listNotes.mockImplementation(async () => [...rows.values()]);
  api.listNoteTags.mockResolvedValue([]);
  api.getActiveNote.mockResolvedValue(original);
  api.setActiveNote.mockResolvedValue({ ok: true });
  api.onNoteInjectResult.mockReturnValue(() => {});
  api.saveNote.mockImplementation(async (input: NoteSaveInput) => persist(input));
  api.saveNoteSync.mockImplementation((input: NoteSaveInput) => { persist(input); return { ok: true }; });
});
afterEach(async () => {
  harness.unmount();
  await settleHooks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('note draft persistence', () => {
  it('retains a failed autosave for a vetoed handoff and a later retry without new input', async () => {
    const hook = await mountNotes();
    api.saveNote.mockRejectedValue(new Error('Disk full'));
    api.saveNoteSync.mockReturnValue({ ok: false });
    hook.current.handleContentChange('Keep my draft', '{"version":1}');
    await vi.advanceTimersByTimeAsync(800);

    const failed = handoff();
    await settleHooks();
    expect(failed.defaultPrevented).toBe(true);
    expect(api.saveNoteSync).toHaveBeenCalledWith(expect.objectContaining({ id: original.id, content: 'Keep my draft' }));
    expect(hook.current.toast).toMatch(/保存失败.*保留.*重试/);

    api.saveNoteSync.mockImplementation((input: NoteSaveInput) => { persist(input); return { ok: true }; });
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Keep my draft');
    const writes = api.saveNoteSync.mock.calls.length;
    handoff();
    expect(api.saveNoteSync).toHaveBeenCalledTimes(writes);
  });

  it.each(['select', 'new'] as const)('blocks %s when the current draft cannot be saved', async (action) => {
    const hook = await mountNotes();
    api.saveNote.mockRejectedValue(new Error('Disk full'));
    hook.current.handleContentChange('Unsaved', '{}');
    if (action === 'select') await hook.current.handleSelectNote(other);
    else await hook.current.handleNew();
    await settleHooks();
    expect(hook.current.activeNote?.id).toBe(original.id);
    expect(api.setActiveNote).not.toHaveBeenCalled();
    expect(hook.current.toast).toMatch(/保存失败.*保留.*重试/);
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Unsaved');
  });

  it('saves an existing note cleared to empty content asynchronously', async () => {
    const hook = await mountNotes();
    hook.current.handleContentChange('', '{"type":"doc"}');
    await vi.advanceTimersByTimeAsync(800);
    expect(api.saveNote).toHaveBeenCalledWith(expect.objectContaining({ id: original.id, content: '' }));
    expect(rows.get(original.id)?.content).toBe('');
    expect(hook.current.activeNote?.content).toBe('');
  });

  it('saves an existing note cleared to whitespace synchronously', async () => {
    const hook = await mountNotes();
    hook.current.handleContentChange('  ', '{}');
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('  ');
  });

  it('backfills a temporary note id and reuses it for later edits', async () => {
    const hook = await mountNotes();
    await hook.current.handleNew();
    await settleHooks();
    api.saveNote.mockClear();
    hook.current.handleContentChange('First version', '{}');
    await vi.advanceTimersByTimeAsync(800);
    const savedId = hook.current.activeNote?.id;
    expect(savedId).toBeTruthy();
    expect(hook.current.activeNote?.content).toBe('First version');
    hook.current.handleContentChange('Second version', '{}');
    await vi.advanceTimersByTimeAsync(800);
    expect(api.saveNote.mock.calls[1][0].id).toBe(savedId);
    expect(rows.size).toBe(3);
    expect(rows.get(savedId!)?.content).toBe('Second version');
  });

  it('uses one id when a new note is saved by repeated synchronous handoffs', async () => {
    const hook = await mountNotes();
    await hook.current.handleNew();
    await settleHooks();
    hook.current.handleContentChange('First sync version', '{}');
    handoff();
    // Input can arrive before React commits the state update from the first save.
    hook.current.handleContentChange('Second sync version', '{}');
    handoff();
    await settleHooks();
    expect(rows.size).toBe(3);
    expect(hook.current.activeNote?.id).toBeTruthy();
    expect(api.saveNoteSync.mock.calls.at(-1)?.[0].id).toBe(api.saveNoteSync.mock.calls[0][0].id);
    expect(hook.current.activeNote?.content).toBe('Second sync version');
  });

  it('vetoes handoff during an in-flight write, then saves only the newest version', async () => {
    const hook = await mountNotes();
    const pending = deferred<Note>();
    api.saveNote.mockReturnValueOnce(pending.promise);
    hook.current.handleContentChange('Older in-flight text', '{}');
    await vi.advanceTimersByTimeAsync(800);
    hook.current.handleContentChange('Newest text', '{"version":2}');
    expect(handoff().defaultPrevented).toBe(true);
    expect(api.saveNoteSync).not.toHaveBeenCalled();
    await settleHooks();
    expect(hook.current.toast).toMatch(/正在保存.*重试/);
    pending.resolve(persist(api.saveNote.mock.calls[0][0]));
    await settleHooks();
    expect(hook.current.activeNote?.content).not.toBe('Older in-flight text');
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Newest text');
  });

  it('waits for an in-flight write and flushes newer input before switching', async () => {
    const hook = await mountNotes();
    const pending = deferred<Note>();
    api.saveNote.mockReturnValueOnce(pending.promise);
    hook.current.handleContentChange('Older', '{}');
    await vi.advanceTimersByTimeAsync(800);
    hook.current.handleContentChange('Latest before switch', '{}');
    const selection = hook.current.handleSelectNote(other);
    await settleHooks();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(api.setActiveNote).not.toHaveBeenCalled();
    pending.resolve(persist(api.saveNote.mock.calls[0][0]));
    await selection;
    await settleHooks();
    expect(rows.get(original.id)?.content).toBe('Latest before switch');
    expect(hook.current.activeNote?.id).toBe(other.id);
  });

  it('keeps the first note id when a committed write loses its reply', async () => {
    const hook = await mountNotes();
    await hook.current.handleNew();
    await settleHooks();
    api.saveNote.mockImplementationOnce(async (input: NoteSaveInput) => {
      persist(input);
      throw new Error('Reply lost');
    });
    hook.current.handleContentChange('Created once', '{}');
    await vi.advanceTimersByTimeAsync(800);
    hook.current.handleContentChange('Retried content', '{}');
    expect(handoff().defaultPrevented).toBe(false);
    await settleHooks();
    expect(rows.size).toBe(3);
    expect(rows.get(hook.current.activeNote!.id)?.content).toBe('Retried content');
  });

  it('retains the newest version if an older in-flight save fails', async () => {
    const hook = await mountNotes();
    const pending = deferred<Note>();
    api.saveNote.mockReturnValueOnce(pending.promise);
    hook.current.handleContentChange('Older', '{}');
    await vi.advanceTimersByTimeAsync(800);
    hook.current.handleContentChange('Latest', '{}');
    const selection = hook.current.handleSelectNote(other);
    pending.reject(new Error('Disk full'));
    await selection;
    await settleHooks();
    expect(hook.current.activeNote?.id).toBe(original.id);
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Latest');
  });

  it('backfills a new id without replacing edits made during its first save', async () => {
    const hook = await mountNotes();
    await hook.current.handleNew();
    await settleHooks();
    const pending = deferred<Note>();
    const second = deferred<Note>();
    api.saveNote.mockReturnValueOnce(pending.promise).mockReturnValueOnce(second.promise);
    hook.current.handleContentChange('First version', '{}');
    await vi.advanceTimersByTimeAsync(800);
    hook.current.handleContentChange('Newer version', '{}');
    pending.resolve(persist(api.saveNote.mock.calls.at(-1)![0]));
    await settleHooks();
    expect(hook.current.activeNote?.id).toBeTruthy();
    expect(hook.current.activeNote?.content).toBe('Newer version');
    const latestInput = api.saveNote.mock.calls.at(-1)![0];
    second.resolve(persist(latestInput));
    await settleHooks();
    expect(rows.size).toBe(3);
    expect(latestInput.id).toBe(hook.current.activeNote?.id);
    expect(handoff().defaultPrevented).toBe(false);
    expect(api.saveNoteSync).not.toHaveBeenCalled();
  });

  it.each(['select', 'new'] as const)('saves edits made during %s activation before replacing the editor', async (action) => {
    const hook = await mountNotes();
    const activation = deferred<{ ok: boolean }>();
    api.setActiveNote.mockReturnValueOnce(activation.promise);
    hook.current.handleContentChange('Before activation', '{}');
    const transition = action === 'select' ? hook.current.handleSelectNote(other) : hook.current.handleNew();
    await settleHooks();
    hook.current.handleContentChange('Edited during activation', '{}');
    activation.resolve({ ok: true });
    await transition;
    await settleHooks();
    expect(rows.get(original.id)?.content).toBe('Edited during activation');
    expect(hook.current.activeNote?.id).toBe(action === 'select' ? other.id : '');
  });

  it('keeps the editor and draft if the post-activation save fails', async () => {
    const hook = await mountNotes();
    const activation = deferred<{ ok: boolean }>();
    api.setActiveNote.mockReturnValueOnce(activation.promise);
    hook.current.handleContentChange('Before activation', '{}');
    const selection = hook.current.handleSelectNote(other);
    await settleHooks();
    hook.current.handleContentChange('Still unsaved', '{}');
    api.saveNote.mockRejectedValueOnce(new Error('Disk full'));
    activation.resolve({ ok: true });
    await selection;
    await settleHooks();
    expect(hook.current.activeNote?.id).toBe(original.id);
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Still unsaved');
  });

  it('does not restore a stale sidebar snapshot when selecting the current note', async () => {
    const hook = await mountNotes();
    hook.current.handleContentChange('Updated current note', '{}');
    await hook.current.handleSelectNote(original);
    expect(handoff().defaultPrevented).toBe(false);
    expect(rows.get(original.id)?.content).toBe('Updated current note');
  });

  it('refuses view navigation on failure and commits a later successful retry', async () => {
    const hook = await mountNotes();
    const commit = vi.fn();
    api.saveNote.mockRejectedValueOnce(new Error('Disk full'));
    hook.current.handleContentChange('Before leaving', '{}');
    await hook.current.beforeLeave(commit);
    expect(commit).not.toHaveBeenCalled();
    await hook.current.beforeLeave(commit);
    expect(rows.get(original.id)?.content).toBe('Before leaving');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not allow view navigation to overtake an internal note transition', async () => {
    const hook = await mountNotes();
    const activation = deferred<{ ok: boolean }>();
    api.setActiveNote.mockReturnValueOnce(activation.promise);
    const transition = hook.current.handleSelectNote(other);
    await settleHooks();
    const commit = vi.fn();
    await hook.current.beforeLeave(commit);
    expect(commit).not.toHaveBeenCalled();
    activation.resolve({ ok: true });
    await transition;
    await hook.current.beforeLeave(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not allow an internal transition to overtake a pending view save', async () => {
    const hook = await mountNotes();
    const pending = deferred<Note>();
    api.saveNote.mockReturnValueOnce(pending.promise);
    hook.current.handleContentChange('Before leaving', '{}');
    const commit = vi.fn();
    const leaving = hook.current.beforeLeave(commit);
    await hook.current.handleNew();
    expect(api.setActiveNote).not.toHaveBeenCalled();
    pending.resolve(persist(api.saveNote.mock.calls[0][0]));
    await leaving;
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps an untouched temporary note out of storage', async () => {
    const hook = await mountNotes();
    await hook.current.handleNew();
    await settleHooks();
    const writes = api.saveNote.mock.calls.length;
    hook.current.handleContentChange('  ', '{}');
    await vi.advanceTimersByTimeAsync(800);
    expect(handoff().defaultPrevented).toBe(false);
    expect(api.saveNote).toHaveBeenCalledTimes(writes);
    expect(api.saveNoteSync).not.toHaveBeenCalled();
    expect(rows.size).toBe(2);
  });

  it('does not report a successful write as failed when refreshing the list fails', async () => {
    const hook = await mountNotes();
    api.listNotes.mockRejectedValue(new Error('List unavailable'));
    hook.current.handleContentChange('Persisted', '{}');
    await vi.advanceTimersByTimeAsync(800);
    expect(rows.get(original.id)?.content).toBe('Persisted');
    expect(handoff().defaultPrevented).toBe(false);
    expect(api.saveNoteSync).not.toHaveBeenCalled();
  });
});
