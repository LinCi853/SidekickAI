/* =====================================================================
   ui/FormRow.tsx —— 设置项通用行布局组件
   提供 label + hint + 右侧控件的统一行布局，替代各 section 手写的样板。
   ===================================================================== */

import type { ReactNode } from 'react';
import './FormRow.css';

export interface FormRowProps {
  /** 主标签文本 */
  label: string;
  /** 辅助说明文本（显示在主标签下方） */
  hint?: string;
  /** 右侧控件 */
  children: ReactNode;
  /** 纵向堆叠变体（标签在上，控件在下） */
  stack?: boolean;
  /** 紧凑变体（减小间距） */
  compact?: boolean;
  /** 关联控件 id（用于 label htmlFor） */
  htmlFor?: string;
  /** 额外 className */
  className?: string;
}

export default function FormRow({
  label,
  hint,
  children,
  stack = false,
  compact = false,
  htmlFor,
  className,
}: FormRowProps) {
  const cls = [
    'form-row',
    stack && 'stack',
    compact && 'compact',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} data-name="ui.form-row">
      <label className="form-row-label" htmlFor={htmlFor} data-name="ui.form-row.label">
        <span className="form-row-name" data-name="ui.form-row.name">{label}</span>
        {hint && <span className="form-row-hint" data-name="ui.form-row.hint">{hint}</span>}
      </label>
      <div className="form-row-control" data-name="ui.form-row.control">{children}</div>
    </div>
  );
}
