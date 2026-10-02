import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptTemplate } from '../lib/electron-api';
import { deferred, settleHooks } from '../hooks/draft-hook-test-harness';

const api = vi.hoisted(() => ({ listPrompts: vi.fn(), savePrompt: vi.fn(), deletePrompt: vi.fn() }));
vi.mock('../lib/electron-api', () => api);
let store: typeof import('./usePromptStore').usePromptStore;
let changed: () => void;
let cleared: () => void;
const template: PromptTemplate = { id: 'template-a', title: 'A', content: 'A text', createdAt: 1, updatedAt: 1 };

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { electron: {
    onPromptsChanged: (handler: () => void) => { changed = handler; return () => {}; },
    onAiAssetsCleared: (handler: () => void) => { cleared = handler; return () => {}; },
  } });
  api.listPrompts.mockResolvedValue([template]);
  api.savePrompt.mockResolvedValue(template);
  api.deletePrompt.mockResolvedValue(undefined);
  store = (await import('./usePromptStore')).usePromptStore;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('prompt list ownership', () => {
  it('keeps the newest broadcast read when an older list completes later', async () => {
    const older = deferred<PromptTemplate[]>();
    api.listPrompts.mockReturnValueOnce(older.promise).mockResolvedValueOnce([]);
    const initial = store.getState().init(); changed(); await settleHooks();
    expect(store.getState().prompts).toEqual([]);
    older.resolve([template]); await initial;
    expect(store.getState().prompts).toEqual([]);
  });

  it('does not mark a pending newer read initialized when an old read fails', async () => {
    const older = deferred<PromptTemplate[]>(), newer = deferred<PromptTemplate[]>();
    api.listPrompts.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const initial = store.getState().init(); changed(); older.reject(new Error('Old read failed')); await initial;
    expect(store.getState().initialized).toBe(false);
    newer.resolve([template]); await settleHooks();
    expect(store.getState().initialized).toBe(true);
  });

  it('keeps cleared templates empty after a pre-clear read completes', async () => {
    const pending = deferred<PromptTemplate[]>(); api.listPrompts.mockReturnValueOnce(pending.promise);
    const loading = store.getState().init(); cleared(); pending.resolve([template]); await loading;
    expect(store.getState().prompts).toEqual([]);
    expect(store.getState().initialized).toBe(true);
  });

  it('loads the persisted save result without accepting an older list snapshot', async () => {
    const older = deferred<PromptTemplate[]>();
    api.listPrompts.mockReturnValueOnce(older.promise);
    const loading = store.getState().init();
    const updated = { ...template, content: 'New text' };
    api.savePrompt.mockResolvedValue(updated); api.listPrompts.mockResolvedValue([updated]);
    await store.getState().save(updated); older.resolve([template]); await loading;
    expect(store.getState().prompts).toEqual([updated]);
  });

  it('keeps a deletion after a pre-delete read completes', async () => {
    const older = deferred<PromptTemplate[]>(); api.listPrompts.mockReturnValueOnce(older.promise);
    const loading = store.getState().init(); api.listPrompts.mockResolvedValue([]);
    await store.getState().remove(template.id); older.resolve([template]); await loading;
    expect(store.getState().prompts).toEqual([]);
  });

  it('does not refresh or refill after a save response from before clearing', async () => {
    await store.getState().init(); const pending = deferred<PromptTemplate>();
    api.savePrompt.mockReturnValueOnce(pending.promise);
    const writing = store.getState().save(template); cleared(); pending.resolve(template); await writing;
    expect(store.getState().prompts).toEqual([]);
    expect(api.listPrompts).toHaveBeenCalledTimes(1);
  });

  it('retains independent templates saved concurrently by reading persistence', async () => {
    await store.getState().init(); const first = deferred<PromptTemplate>(), second = deferred<PromptTemplate>();
    const other = { ...template, id: 'template-b', title: 'B' };
    api.savePrompt.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = store.getState().save(template), b = store.getState().save(other);
    api.listPrompts.mockResolvedValue([template, other]);
    second.resolve(other); await b; first.resolve(template); await a;
    expect(store.getState().prompts).toEqual([template, other]);
  });

  it.each(['save', 'remove'] as const)('preserves the list and rejects a failed %s', async operation => {
    await store.getState().init(); const failure = new Error('Persistence unavailable');
    api.savePrompt.mockRejectedValue(failure); api.deletePrompt.mockRejectedValue(failure);
    await expect(operation === 'save' ? store.getState().save(template) : store.getState().remove(template.id)).rejects.toBe(failure);
    expect(store.getState().prompts).toEqual([template]);
  });
});
