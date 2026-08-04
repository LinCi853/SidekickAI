/* =====================================================================
   ui/IconButton.tsx —— 纯图标按钮组件
   依赖 globals.css 的 .btn-icon 全局类
   支持 default / close / active 三种状态修饰
   ===================================================================== */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonVariant = 'default' | 'close' | 'active';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉状态：default(默认) / close(关闭按钮，hover 红底) / active(激活态) */
  variant?: IconButtonVariant;
  /** 无障碍标签（强烈建议提供，等同于 aria-label） */
  'aria-label': string;
  /** 图标内容（通常为 SVG） */
  children: ReactNode;
}

/** 计算 IconButton className —— 组合 .btn-icon + 状态修饰 */
function resolveClass(variant: IconButtonVariant, extra?: string): string {
  const mod =
    variant === 'close' ? 'is-close'
    : variant === 'active' ? 'is-active'
    : '';
  return ['btn-icon', mod, extra].filter(Boolean).join(' ');
}

/**
 * 图标按钮 —— 用于导航、窗口控制、工具栏等纯图标场景
 *
 * @example
 * <IconButton aria-label="关闭" variant="close" onClick={handleClose}>
 *   <XIcon />
 * </IconButton>
 * <IconButton aria-label="置顶" variant={isPinned ? 'active' : 'default'} onClick={togglePin}>
 *   <PinIcon />
 * </IconButton>
 */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'default', className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={resolveClass(variant, className)} {...rest}>
      {children}
    </button>
  );
});

export default IconButton;
