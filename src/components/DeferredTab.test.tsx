import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runner = await vi.hoisted(async () => {
  const { createHookHarness } = await import('../test/hook-harness');
  return { current: createHookHarness(), create: createHookHarness };
});
vi.mock('react', () => ({
  useState: (...args: [unknown]) => runner.current.hooks.useState(...args),
  useEffect: (...args: [() => void, unknown[]]) => runner.current.hooks.useEffect(...args),
}));
import DeferredTab from './DeferredTab';

beforeEach(() => { runner.current = runner.create(); });
afterEach(() => { runner.current.unmount(); });

describe('deferred webpage tabs', () => {
  it('leaves an unselected restored tab unmounted', () => {
    expect(runner.current.render(() => DeferredTab({ active: false, children: 'page' }))).toBeNull();
    expect(runner.current.render(() => DeferredTab({ active: false, children: 'page' }))).toBeNull();
  });

  it('mounts immediately on selection and retains the same child after switching away', () => {
    const child = { page: 'draft' } as any;
    const render = (active: boolean) => runner.current.render(() => DeferredTab({ active, children: child }));
    expect(render(false)).toBeNull();
    expect(render(true)).toBe(child);
    expect(render(false)).toBe(child);
    expect(render(true)).toBe(child);
  });

  it('retains an initially active tab and defers it again in a fresh window lifetime', () => {
    expect(runner.current.render(() => DeferredTab({ active: true, children: 'page' }))).toBe('page');
    expect(runner.current.render(() => DeferredTab({ active: false, children: 'page' }))).toBe('page');
    runner.current.unmount(); runner.current = runner.create();
    expect(runner.current.render(() => DeferredTab({ active: false, children: 'page' }))).toBeNull();
  });
});
