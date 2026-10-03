import { useEffect, type RefObject } from 'react';

export function useAssetMenuDismissal(root: RefObject<HTMLElement>) {
  useEffect(() => {
    const menus = () => Array.from(root.current?.querySelectorAll<HTMLDetailsElement>('details.asset-operation-menu[open]') ?? []);
    const outside = (event: PointerEvent) => menus().forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
    const choose = (event: MouseEvent) => {
      const button = (event.target as Element).closest('button');
      if (button) menus().forEach(menu => { if (menu.contains(button)) menu.open = false; });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const open = menus();
      if (!open.length) return;
      event.preventDefault(); event.stopImmediatePropagation();
      open.forEach(menu => { menu.open = false; menu.querySelector('summary')?.focus(); });
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('click', choose, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('click', choose, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [root]);
}
