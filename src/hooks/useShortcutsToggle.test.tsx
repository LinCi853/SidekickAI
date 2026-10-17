import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ShortcutEntry } from './useShortcutRegistry';

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('./useShortcutRegistry', () => ({ useShortcutRegistry: register }));
vi.mock('../store/useShortcutDocStore', () => ({ useRegisterShortcutDocs: () => {} }));
import { useShortcutsToggle } from './useShortcutsToggle';

function Probe({ open, setOpen }: { open: boolean; setOpen: (value: boolean) => void }) {
  useShortcutsToggle(open, setOpen);
  return null;
}

it('closes on release through the callback retained when the key was pressed', () => {
  const setOpen = vi.fn();
  const event = { preventDefault: vi.fn() } as unknown as KeyboardEvent;
  renderToStaticMarkup(<Probe open={false} setOpen={setOpen} />);
  const pressedEntry = register.mock.lastCall![0][0] as ShortcutEntry;
  pressedEntry.onHoldStart!(event);
  renderToStaticMarkup(<Probe open setOpen={setOpen} />);
  pressedEntry.onHoldEnd!(event);
  expect(setOpen.mock.calls).toEqual([[true], [false]]);
});
