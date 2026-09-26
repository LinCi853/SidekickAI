import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createHookHarness, deferred, settleHooks } from '../hooks/draft-hook-test-harness';

const fixture = vi.hoisted(() => ({
  runtime: null as any,
  options: null as any,
  realAutoSave: false,
  flush: vi.fn(),
  save: vi.fn(),
  saveSync: vi.fn(),
  create: vi.fn(),
  select: vi.fn(),
  snapshot: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (...args: any[]) => fixture.runtime.react.useRef(...args),
  useState: (...args: any[]) => fixture.runtime.react.useState(...args),
  useCallback: (...args: any[]) => fixture.runtime.react.useCallback(...args),
  useEffect: (...args: any[]) => fixture.runtime.react.useEffect(...args),
  useMemo: (factory: () => any, deps: any[]) => {
    const ref = fixture.runtime.react.useRef(null);
    if (!ref.current || deps.some((value, index) => value !== ref.current.deps[index])) {
      ref.current = { value: factory(), deps };
    }
    return ref.current.value;
  },
}));
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: 'fixture-canvas',
  serializeAsJSON: (elements: unknown, appState: unknown, files: unknown) => JSON.stringify({ elements, appState, files }),
  FONT_FAMILY: {}, MIME_TYPES: {},
}));
vi.mock('../lib/electron-api', () => ({
  listWhiteboards: async () => [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  getActiveWhiteboardId: async () => 'a',
  getWhiteboardSnapshot: fixture.snapshot,
  getAppSettings: async () => ({}), updateAppSettings: async () => {},
  setActiveWhiteboardId: fixture.select,
  createWhiteboard: fixture.create,
  renameWhiteboard: async () => {}, deleteWhiteboard: fixture.remove,
  saveWhiteboardSnapshot: fixture.save,
  saveWhiteboardSnapshotSync: fixture.saveSync,
  onWhiteboardPushImage: () => () => {},
}));
vi.mock('../components/ui', () => ({ IconButton: 'button', EmptyState: 'empty-state' }));
vi.mock('../components/SidebarShell', () => ({ default: 'sidebar-shell' }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ toast: null, showToast: toast }) }));
vi.mock('../hooks/useAutoSaveDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAutoSaveDraft')>();
  return {
    useAutoSaveDraft: (options: any) => {
      fixture.options = options;
      if (fixture.realAutoSave) return actual.useAutoSaveDraft(options);
      return { schedule: () => {}, flushNow: fixture.flush };
    },
  };
});
const toast = vi.fn();
import WhiteboardView from './WhiteboardView';

function find(node: any, predicate: (element: ReactElement<any>) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}
const named = (node: any, name: string) => find(node, element => typeof element.type === 'function' && element.type.name === name);

async function mountView() {
  const harness = createHookHarness();
  harness.reset();
  let leave: any;
  // Evaluate the component directly, without mounting its children.
  const mounted = harness.mount(() => {
    fixture.runtime = harness;
    return WhiteboardView({ sidebarVisible: true, onBeforeLeaveReady: (handler: any) => { leave = handler; } } as any);
  });
  await settleHooks();
  return { view: mounted, harness, get leave() { return leave; } };
}

async function mountCanvas() {
  const parent = await mountView();
  const element = named(parent.view.current, 'WhiteboardCanvas');
  const harness = createHookHarness();
  harness.reset();
  let flush: any;
  const view = harness.mount(() => {
    fixture.runtime = harness;
    return element.type({ ...element.props, onFlushReady: (handler: any) => { flush = handler; } });
  });
  const canvas = find(view.current, node => node.type === 'fixture-canvas');
  canvas.props.excalidrawAPI({});
  canvas.props.onChange([{ id: 'latest-shape' }], {}, {});
  return { view, harness, canvas, get flush() { return flush; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.realAutoSave = false;
  fixture.save.mockResolvedValue({ ok: true });
  fixture.saveSync.mockReturnValue({ ok: true });
  fixture.flush.mockResolvedValue(undefined);
  fixture.snapshot.mockImplementation(async (id: string) => JSON.stringify({ elements: [{ id: `saved-${id}` }] }));
  fixture.select.mockResolvedValue({ ok: true });
  fixture.create.mockResolvedValue({ id: 'new', title: 'New' });
  fixture.remove.mockResolvedValue({ ok: true });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('whiteboard save failures and navigation', () => {
  it('catches the real 500ms autosave failure, vetoes handoff/unload, and retries the retained scene', async () => {
    vi.useFakeTimers();
    fixture.realAutoSave = true;
    fixture.save.mockResolvedValue({ ok: false });
    fixture.saveSync.mockReturnValue({ ok: false });
    const mounted = await mountCanvas();
    await vi.advanceTimersByTimeAsync(500);
    await settleHooks();
    expect(fixture.save).toHaveBeenCalledOnce();
    expect(find(mounted.view.current, node => node.props?.role === 'alert')?.props.children[0]).toContain('保存失败');
    expect(window.dispatchEvent(new Event('sidekick:before-handoff', { cancelable: true }))).toBe(false);
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    fixture.save.mockResolvedValue({ ok: true });
    await mounted.flush();
    await settleHooks();
    expect(fixture.save.mock.calls[1][1]).toContain('latest-shape');
    expect(find(mounted.view.current, node => node.props?.role === 'alert')).toBeNull();
    expect(window.dispatchEvent(new Event('sidekick:before-handoff', { cancelable: true }))).toBe(true);
    mounted.harness.unmount();
    await settleHooks();
  });

  it('rejects a second flush failure after destination loading without replacing the old canvas', async () => {
    const mounted = await mountView();
    const flush = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new edit failed'));
    named(mounted.view.current, 'WhiteboardCanvas').props.onFlushReady(flush);
    await named(mounted.view.current, 'WhiteboardSidebar').props.onSelect('b');
    await settleHooks();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(named(mounted.view.current, 'WhiteboardCanvas').props.activeId).toBe('a');
    expect(find(mounted.view.current, node => node.props?.role === 'alert')?.props.children).toContain('已保留当前画面');
  });

  it('returns the asynchronous persistence promise instead of losing its rejection', async () => {
    await mountCanvas();
    const write = deferred<void>();
    fixture.save.mockReturnValue(write.promise);
    const saved = fixture.options.save('a');
    // Attach immediately so the pre-fix fire-and-forget defect cannot leak a rejection to the runner.
    write.promise.catch(() => {});
    expect(saved).toBeInstanceOf(Promise);
    write.reject(new Error('SQLITE_FULL fixture'));
    await expect(saved).rejects.toThrow('SQLITE_FULL');
  });

  it('shows a persistent Chinese failure state from background save errors', async () => {
    const mounted = await mountCanvas();
    expect(fixture.options.onError).toBeTypeOf('function');
    fixture.options.onError(new Error('SQLITE_FULL fixture'));
    await settleHooks();
    expect(find(mounted.view.current, node => node.props?.role === 'alert')?.props.children[0]).toContain('保存失败');
  });

  it.each(['onSelect', 'onCreate', 'onDelete'] as const)('does not unmount the current scene when %s flush fails', async (operation) => {
    const mounted = await mountView();
    const board = named(mounted.view.current, 'WhiteboardCanvas');
    const failedFlush = vi.fn().mockRejectedValue(new Error('SQLITE_FULL fixture'));
    board.props.onFlushReady?.(failedFlush);
    const sidebar = named(mounted.view.current, 'WhiteboardSidebar');
    await sidebar.props[operation](operation === 'onSelect' ? 'b' : 'a');
    await settleHooks();
    expect(failedFlush).toHaveBeenCalledOnce();
    expect(named(mounted.view.current, 'WhiteboardCanvas').props.activeId).toBe('a');
    expect(fixture.select).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it('registers a before-leave guard and rejects leaving on failed flush', async () => {
    const mounted = await mountView();
    const board = named(mounted.view.current, 'WhiteboardCanvas');
    board.props.onFlushReady?.(vi.fn().mockRejectedValue(new Error('SQLITE_FULL fixture')));
    const navigate = vi.fn();
    expect(mounted.leave).toBeTypeOf('function');
    await mounted.leave(navigate);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('coalesces repeated navigation and loads the target before committing its canvas', async () => {
    const mounted = await mountView();
    const saving = deferred<void>();
    const flush = vi.fn().mockReturnValue(saving.promise);
    named(mounted.view.current, 'WhiteboardCanvas').props.onFlushReady?.(flush);
    const sidebar = named(mounted.view.current, 'WhiteboardSidebar');
    const first = sidebar.props.onSelect('b');
    const duplicate = sidebar.props.onCreate();
    await settleHooks();
    expect(named(mounted.view.current, 'WhiteboardCanvas').props.activeId).toBe('a');
    expect(fixture.create).not.toHaveBeenCalled();
    saving.resolve();
    await Promise.all([first, duplicate]);
    await settleHooks();
    const next = named(mounted.view.current, 'WhiteboardCanvas');
    expect(next.props.activeId).toBe('b');
    expect(next.props.snapshot).toContain('saved-b');
    expect(fixture.select).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
