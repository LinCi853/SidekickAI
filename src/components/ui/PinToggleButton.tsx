/* =====================================================================
   ui/PinToggleButton.tsx —— 置顶切换按钮
   统一各窗口顶栏的置顶按钮（替代 9 处分散的内联 SVG + 状态切换逻辑）
   ===================================================================== */

import type { ButtonHTMLAttributes } from 'react';
import IconButton from './IconButton';

export interface PinToggleButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type' | 'aria-label'> {
  /** 是否已置顶 */
  isPinned: boolean;
  /** 切换回调 */
  onToggle: () => void;
}

/**
 * 置顶切换按钮 —— 图钉图标，fill 随状态切换
 *
 * @example
 * <PinToggleButton isPinned={isPinned} onToggle={handleTogglePin} />
 * <PinToggleButton isPinned={isPinned} onToggle={handleTogglePin} data-name="topbar.pin" />
 */
export default function PinToggleButton({
  isPinned,
  onToggle,
  disabled = false,
  ...rest
}: PinToggleButtonProps) {
  return (
    <IconButton
      type="button"
      variant={isPinned ? 'active' : 'default'}
      aria-label={isPinned ? '取消置顶' : '置顶'}
      title={isPinned ? '取消置顶' : '置顶'}
      onClick={onToggle}
      disabled={disabled}
      {...rest}
    >
      <svg
        className="icon-svg"
        viewBox="0 0 24 24"
        fill={isPinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="12" y1="17" x2="12" y2="3" />
        <path d="M6.5 8.5L12 3l5.5 5.5" />
        <path d="M5 21h14" />
      </svg>
    </IconButton>
  );
}
