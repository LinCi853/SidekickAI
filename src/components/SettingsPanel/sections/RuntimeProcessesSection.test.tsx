import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, settleHooks } from '../../../hooks/draft-hook-test-harness';
import { elements } from '../../../test/hook-harness';
import type { RuntimeProcessSnapshot } from '../../../../electron/shared/runtime-processes';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../../../hooks/draft-hook-test-harness');
  return createHookHarness();
});
const api = vi.hoisted(() => ({ getRuntimeProcesses: vi.fn() }));
vi.mock('react', () => runner.react);
vi.mock('../../../lib/electron-api', () => api);
vi.mock('../../ui', () => ({ SectionTitle: 'section-title', IconButton: 'icon-button' }));
import RuntimeProcessesSection from './RuntimeProcessesSection';

let visibility: EventTarget & { hidden: boolean };
const snapshot: RuntimeProcessSnapshot = { capturedAt: 1000, processes: [
  { pid: 123, creationTime: 200, role: 'webpage', name: '', targets: [
    { webContentsId: 2, kind: 'webpage', title: 'Fixture A', windowTitle: 'Main window' },
  ], cpuPercent: 2.25, memoryBytes: 1048576 },
] };
const text = (tree: unknown): string => {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return tree && typeof tree === 'object' && 'props' in tree ? text((tree as any).props.children) : '';
};
const refreshButton = (tree: unknown) => elements(tree).flatMap(item => [item, ...elements(item.props?.actions)])
  .find(item => item.props?.['data-name'] === 'settings.advanced.processes.refresh')!;

beforeEach(() => {
  vi.useFakeTimers(); runner.reset(); vi.resetAllMocks();
  visibility = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', visibility);
  api.getRuntimeProcesses.mockResolvedValue(snapshot);
});
afterEach(() => { runner.unmount(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('running process settings', () => {
  it('polls only a visible active view and releases polling on unmount', async () => {
    const view = runner.mount(() => RuntimeProcessesSection({}));
    await settleHooks();
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(1);
    expect(text(view.current)).toContain('网页');
    expect(text(view.current)).toContain('Fixture A');
    expect(text(view.current)).toContain('123');
    expect(text(view.current)).toContain('2.3%');
    expect(text(view.current)).toContain('1.0 MB');
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(2);
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
    await settleHooks();
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(3);
    runner.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('avoids overlapping manual and periodic requests', async () => {
    const pending = deferred<RuntimeProcessSnapshot>();
    api.getRuntimeProcesses.mockReturnValue(pending.promise);
    const view = runner.mount(() => RuntimeProcessesSection({}));
    await settleHooks();
    refreshButton(view.current).props.onClick(); refreshButton(view.current).props.onClick();
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(1);
    expect(refreshButton(view.current).props.disabled).toBe(true);
    pending.resolve(snapshot); await settleHooks();
    expect(refreshButton(view.current).props.disabled).toBe(false);
    expect(text(view.current)).toContain('Fixture A');
  });

  it('keeps failures retryable and retains the last successful sample', async () => {
    const view = runner.mount(() => RuntimeProcessesSection({}));
    await settleHooks();
    api.getRuntimeProcesses.mockRejectedValueOnce(new Error('Unavailable'));
    refreshButton(view.current).props.onClick(); await settleHooks();
    expect(text(view.current)).toContain('进程信息读取失败');
    expect(text(view.current)).toContain('Fixture A');
    refreshButton(view.current).props.onClick(); await settleHooks();
    expect(elements(view.current).some(item => item.props?.role === 'alert')).toBe(false);
    expect(refreshButton(view.current).props.disabled).toBe(false);
  });

  it('reports a failed initial sample without claiming that it is still loading', async () => {
    api.getRuntimeProcesses.mockRejectedValueOnce(new Error('Unavailable'));
    const view = runner.mount(() => RuntimeProcessesSection({}));
    await settleHooks();
    expect(text(view.current)).toContain('未获取进程信息');
    expect(text(view.current)).not.toContain('正在读取');
    refreshButton(view.current).props.onClick(); await settleHooks();
    expect(text(view.current)).toContain('1 个进程');
  });

  it('stops a hidden settings panel and ignores its late response', async () => {
    const pending = deferred<RuntimeProcessSnapshot>();
    api.getRuntimeProcesses.mockReturnValueOnce(pending.promise);
    const view = runner.mount(() => RuntimeProcessesSection({ active: false }));
    await settleHooks();
    expect(api.getRuntimeProcesses).not.toHaveBeenCalled();
    runner.mount(() => RuntimeProcessesSection({ active: true })); await settleHooks();
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(1);
    runner.mount(() => RuntimeProcessesSection({ active: false })); await settleHooks();
    pending.resolve(snapshot); await settleHooks();
    expect(text(view.current)).not.toContain('Fixture A');
    expect(vi.getTimerCount()).toBe(0);
    runner.mount(() => RuntimeProcessesSection({ active: true })); await settleHooks();
    expect(api.getRuntimeProcesses).toHaveBeenCalledTimes(2);
    expect(text(view.current)).toContain('Fixture A');
  });
});
