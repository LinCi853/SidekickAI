/* =====================================================================
   ui/ListItem.tsx —— 带操作按钮的列表项
   依赖 globals.css 的 .drawer-item / .card 等基类
   替代 .drawer-item / .provider-action-btn 列表项
   ===================================================================== */

import type { HTMLAttributes, ReactNode } from 'react';

export interface ListItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 左侧前导图标 */
  leadingIcon?: ReactNode;
  /** 主标题 */
  title: ReactNode;
  /** 副标题/描述 */
  subtitle?: ReactNode;
  /** 右侧尾随操作区（按钮组） */
  trailingActions?: ReactNode;
  /** 是否激活态 */
  active?: boolean;
}

/**
 * 列表项 —— 用于抽屉菜单、设置项、AI 应用列表等
 *
 * @example
 * <ListItem
 *   leadingIcon={<SettingsIcon />}
 *   title="设置"
 *   trailingActions={<IconButton aria-label="编辑">...</IconButton>}
 *   onClick={handleOpenSettings}
 * />
 */
export default function ListItem({
  leadingIcon,
  title,
  subtitle,
  trailingActions,
  active = false,
  className,
  ...rest
}: ListItemProps) {
  return (
    <div
      className={['drawer-item', active ? 'active' : '', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {leadingIcon && <span className="drawer-item-icon">{leadingIcon}</span>}
      <span className="drawer-item-text">
        <span className="drawer-item-title">{title}</span>
        {subtitle && <span className="drawer-item-subtitle">{subtitle}</span>}
      </span>
      {trailingActions && <span className="drawer-item-actions">{trailingActions}</span>}
    </div>
  );
}
