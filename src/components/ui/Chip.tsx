/* =====================================================================
   ui/Chip.tsx —— 可点击 chip 组件
   依赖 globals.css 的 .chip-toggle 全局类
   替代 .topbar-chip / .onboarding-toggle-chip
   注意：与 Badge 不同，Chip 是可点击的开关样式；Badge 是只读状态标签
   ===================================================================== */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 是否选中 */
  selected?: boolean;
  /** chip 内容 */
  children: ReactNode;
}

/**
 * 可点击 chip —— 用于顶栏按钮组开关、引导页选项切换
 *
 * @example
 * <Chip selected={visible} onClick={toggle}>{label}</Chip>
 */
export default function Chip({
  selected = false,
  className,
  children,
  ...rest
}: ChipProps) {
  return (
    <button
      type="button"
      className={['chip-toggle', selected ? 'is-on' : '', className].filter(Boolean).join(' ')}
      aria-pressed={selected}
      {...rest}
    >
      {children}
    </button>
  );
}
