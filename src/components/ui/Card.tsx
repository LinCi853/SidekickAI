/* =====================================================================
   ui/Card.tsx —— 卡片容器组件
   依赖 globals.css 的 .card 全局类
   替代 .app-grid-item / .app-switcher-item / .profile-card 等
   ===================================================================== */

import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** 卡片内容 */
  children: ReactNode;
}

/**
 * 卡片容器 —— 用于列表项、设置组、信息展示等
 *
 * @example
 * <Card onClick={handleClick}>...</Card>
 * <Card className="app-grid-item">...</Card>
 */
export default function Card({
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div className={['card', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}
