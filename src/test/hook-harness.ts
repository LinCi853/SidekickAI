import type { ReactElement } from 'react';

export function createHookHarness() {
  const slots: any[] = [];
  let cursor = 0;
  const effects: Array<() => void> = [];
  const hooks = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(callback: any, dependencies: any[]) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useMemo(factory: any, dependencies: any[]) { return hooks.useCallback(factory, dependencies)(); },
    useEffect(callback: () => void | (() => void), dependencies: any[]) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; });
      }
    },
  };
  return {
    hooks,
    render<T>(render: () => T, beforeEffects?: (result: T) => void): T {
      cursor = 0;
      const result = render();
      beforeEffects?.(result);
      while (effects.length) effects.shift()!();
      return result;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

export function elements(tree: unknown): Array<ReactElement<any> & { ref?: any }> {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  const element = tree as ReactElement<any>;
  return [element, ...elements(element.props?.children)];
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export async function settle() { for (let count = 0; count < 20; count++) await Promise.resolve(); }
