/* =====================================================================
   ui/Badge.tsx —— 徽章组件
   从 globals.css 的 .badge / .badge-accent / .badge-warn 移植
   支持 accent / warn / default 三种变体，可显示左侧圆点
   ===================================================================== */

import type { HTMLAttributes, ReactNode } from 'react';

export type BadgeVariant = 'default' | 'accent' | 'warn';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** 徽章变体 */
  variant?: BadgeVariant;
  /** 是否显示左侧 LED 圆点（呼吸动画） */
  dot?: boolean;
  /** 徽章内容 */
  children: ReactNode;
}

/** 计算徽章 className —— 组合基础类 + 变体类 */
function resolveClass(variant: BadgeVariant, extra?: string): string {
  const variantClass =
    variant === 'accent' ? 'badge-accent' : variant === 'warn' ? 'badge-warn' : '';
  return ['badge', variantClass, extra].filter(Boolean).join(' ');
}

/**
 * 徽章 —— 用于状态标签、版本号、分类标识
 *
 * @example
 * <Badge variant="accent" dot>已激活</Badge>
 * <Badge variant="warn">Beta</Badge>
 */
export default function Badge({
  variant = 'default',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span className={resolveClass(variant, className)} {...rest}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}
