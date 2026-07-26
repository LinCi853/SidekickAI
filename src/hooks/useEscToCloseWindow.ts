import { useEffect, useRef } from 'react';
import { closeCurrentWindow } from '@/lib/electron-api';

/* =====================================================================
   全局浮窗栈：管理同时打开的多个浮窗的 ESC 优先级
   - 后打开的浮窗在栈顶，ESC 优先关闭栈顶浮窗
   - useEscToCloseOverlay 和 ui/Modal 都将 close 函数注册到栈中
   - 只有栈顶的浮窗处理 ESC 并 stopImmediatePropagation，阻止下层浮窗/窗口响应
   ===================================================================== */

const overlayStack: Array<() => void> = [];

/** 将 close 函数压入栈顶，返回移除函数 */
export function pushOverlay(close: () => void): () => void {
  overlayStack.push(close);
  return () => {
    const idx = overlayStack.indexOf(close);
    if (idx !== -1) overlayStack.splice(idx, 1);
  };
}

/** 判断 close 是否在栈顶 */
export function isTopOverlay(close: () => void): boolean {
  return overlayStack[overlayStack.length - 1] === close;
}

/** 判断栈中是否还有任何打开的浮窗 */
export function hasOverlay(): boolean {
  return overlayStack.length > 0;
}

/**
 * 独立窗口快捷键 hook（统一 ESC + Ctrl+W 关窗行为）
 *
 * - ESC：浮窗栈非空时由栈顶浮窗处理（useEscToCloseOverlay / ui/Modal），不关窗；
 *        onEsc 回调用于处理非浮窗状态（如标题编辑态），返回 true 表示已处理；
 *        焦点在 INPUT/TEXTAREA/SELECT/contentEditable 时跳过；
 *        否则关闭窗口。
 * - Ctrl+W（不含 Alt/Meta/Shift）：直接关闭窗口（用户主动按"关闭"快捷键，意图明确）。
 *
 * 监听注册在 window 的 keydown 捕获阶段，优先于子组件响应，
 * 保证即使焦点在子元素上也能稳定拦截 Ctrl+W。
 *
 * @param opts.onEsc   自定义 ESC 拦截回调，返回 true 表示已处理（如退出标题编辑），不关窗
 * @param opts.ctrlW   是否启用 Ctrl+W 关窗，默认 true
 */
export function useEscToCloseWindow(opts: {
  onEsc?: (e: KeyboardEvent) => boolean;
  ctrlW?: boolean;
} = {}): void {
  const { onEsc, ctrlW = true } = opts;
  const onEscRef = useRef(onEsc);
  onEscRef.current = onEsc;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // ESC：浮窗栈非空时由栈顶浮窗处理（已在 capture 阶段先于本监听器执行并 stopImmediatePropagation）
      // 能到达这里说明栈空或栈顶浮窗未处理（如输入框焦点时跳过）
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
        // 浮窗栈非空时，让栈顶浮窗的 onClose 先执行（不关窗）
        if (hasOverlay()) return;
        if (onEscRef.current?.(e)) return;
        e.preventDefault();
        void closeCurrentWindow();
        return;
      }
      // Ctrl+W：直接关窗（与浏览器 Ctrl+W 语义一致，用户主动关闭窗口）
      if (ctrlW && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        void closeCurrentWindow();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [ctrlW]);
}

/**
 * 浮窗 ESC 关闭 hook（主窗口 + 独立窗口通用）
 *
 * 仅在 `open` 为 true 时监听 ESC，触发 `onClose` 关闭浮窗（不关闭窗口）。
 * 焦点在 INPUT/TEXTAREA/SELECT/contentEditable 时跳过（由输入框自行处理 ESC）。
 *
 * 使用全局浮窗栈管理优先级：多个浮窗同时打开时，只有最后打开的（栈顶）处理 ESC。
 * 监听注册在 capture 阶段，先于 useEscToCloseWindow 执行，通过 stopImmediatePropagation 阻止关窗。
 */
export function useEscToCloseOverlay(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const close = () => onCloseRef.current();
    const removeFromStack = pushOverlay(close);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      // 只有栈顶浮窗处理 ESC（后打开的优先）
      if (!isTopOverlay(close)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      removeFromStack();
    };
  }, [open]);
}
