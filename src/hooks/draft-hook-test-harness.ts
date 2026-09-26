import { vi } from 'vitest';

type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };

// A small hook runner keeps these persistence tests independent of a DOM or profile.
// It models stable refs/callbacks, queued state renders, and effect cleanup only.
export function createHookHarness() {
  let slots: unknown[] = [];
  let cursor = 0;
  let pendingEffects: Array<() => void> = [];
  let renderHook: (() => unknown) | undefined;
  let result: unknown;
  let renderQueued = false;
  const sameDeps = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const render = () => {
    if (!renderHook) return;
    cursor = 0;
    result = renderHook();
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
  };
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    void Promise.resolve().then(() => {
      renderQueued = false;
      render();
    });
  };
  const react = {
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useState<T>(initial?: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [slots[index], (update: T | ((previous: T) => T)) => {
        slots[index] = typeof update === 'function' ? (update as (previous: T) => T)(slots[index] as T) : update;
        queueRender();
      }] as const;
    },
    useCallback<T>(callback: T, deps?: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index] as { callback: T; deps?: readonly unknown[] } | undefined;
      if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { callback, deps };
      return (slots[index] as { callback: T }).callback;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const previous = slots[index] as EffectSlot | undefined;
      if (!previous || !sameDeps(previous.deps, deps)) {
        const slot: EffectSlot = { deps };
        slots[index] = slot;
        pendingEffects.push(() => {
          previous?.cleanup?.();
          slot.cleanup = effect() || undefined;
        });
      }
    },
  };
  return {
    react,
    mount<T>(hook: () => T) {
      renderHook = hook;
      render();
      return { get current() { return result as T; } };
    },
    unmount() {
      renderHook = undefined;
      slots.forEach((value) => {
        const slot = value as EffectSlot | undefined;
        const cleanup = slot?.cleanup;
        if (cleanup) {
          slot.cleanup = undefined;
          cleanup();
        }
      });
    },
    reset() {
      slots = [];
      cursor = 0;
      pendingEffects = [];
      renderHook = undefined;
      result = undefined;
      renderQueued = false;
      vi.stubGlobal('window', new EventTarget());
    },
  };
}

export async function settleHooks() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
