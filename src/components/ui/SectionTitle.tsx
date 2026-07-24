/* =====================================================================
   ui/SectionTitle.tsx —— 设置分区标题组件
   替代 SettingsPanel/styles.css 中 .settings-section-title-row
   + .settings-section-title + .collapse-toggle-icon 的手写样板。
   ===================================================================== */

import type { ReactNode } from 'react';
import './SectionTitle.css';

export interface SectionTitleProps {
  /** 标题文本 */
  children: ReactNode;
  /** 分区简介（显示在标题下方） */
  hint?: string;
  /** 是否可折叠 */
  collapsible?: boolean;
  /** 当前是否折叠（仅 collapsible=true 时生效） */
  collapsed?: boolean;
  /** 折叠/展开回调 */
  onToggle?: () => void;
  /** 标题右侧操作区（如按钮） */
  actions?: ReactNode;
  /** 额外 className */
  className?: string;
}

export default function SectionTitle({
  children,
  hint,
  collapsible = false,
  collapsed = false,
  onToggle,
  actions,
  className,
}: SectionTitleProps) {
  const cls = [
    'section-title-row',
    collapsible && 'collapsible',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (collapsible) {
    return (
      <div
        className={cls}
        data-collapsed={collapsed ? 'true' : 'false'}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.();
          }
        }}
        data-name="ui.section-title.collapsible"
      >
        <span className="section-title-toggle-icon" aria-hidden="true" data-name="ui.section-title.toggle-icon">
          {collapsed ? '▼' : '▼'}
        </span>
        <h3 className="section-title" data-name="ui.section-title.title">{children}</h3>
        {actions && <div className="section-title-actions" data-name="ui.section-title.actions">{actions}</div>}
      </div>
    );
  }

  return (
    <div className={cls} data-name="ui.section-title">
      <h3 className="section-title" data-name="ui.section-title.title">{children}</h3>
      {actions && <div className="section-title-actions" data-name="ui.section-title.actions">{actions}</div>}
      {hint && <p className="section-title-hint" data-name="ui.section-title.hint">{hint}</p>}
    </div>
  );
}
