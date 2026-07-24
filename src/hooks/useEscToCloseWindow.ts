import { useEffect, useRef } from 'react';
import { closeCurrentWindow } from '@/lib/electron-api';

/**
 * ESC 关闭窗口 hook
 *
 * 监听 ESC 键：跳过输入框聚焦时的事件，否则关闭当前窗口。
 * 可通过 onEsc 回调拦截 ESC 事件（返回 true 表示已处理，不关闭窗口）。
 *
 * @param opts.skipOnInputFocus  输入框聚焦时跳过（默认 true）
 * @param opts.onEsc             自定义 ESC 拦截回调，返回 true 表示已处理
 */
export function useEscToCloseWindow(opts: {
  skipOnInputFocus?: boolean;
  onEsc?: (e: KeyboardEvent) => boolean;
} = {}): void {
  const { skipOnInputFocus = true, onEsc } = opts;
  const onEscRef = useRef(onEsc);
  onEscRef.current = onEsc;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (skipOnInputFocus) {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      if (onEscRef.current?.(e)) return;
      e.preventDefault();
      void closeCurrentWindow();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [skipOnInputFocus]);
}
