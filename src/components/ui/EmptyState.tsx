/* =====================================================================
   ui/EmptyState.tsx —— 空状态占位组件
   统一列表/面板/编辑器无数据时的占位样式（替代各页面分散的 app-empty-state div）
   ===================================================================== */

import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** 提示文案 */
  message: ReactNode;
  /** 尺寸变体（默认 default） */
  size?: 'default' | 'large';
  /** 是否为加载态（显示"加载中…"） */
  loading?: boolean;
  /** 附加类名 */
  className?: string;
  /** data-name 属性（自动化测试定位） */
  'data-name'?: string;
}

/**
 * 空状态占位 —— 列表为空 / 加载中 / 无搜索结果 等场景
 *
 * @example
 * <EmptyState message="暂无对话数据" />
 * <EmptyState message="未找到匹配内容" size="large" />
 * <EmptyState message="加载中…" loading />
 */
export default function EmptyState({
  message,
  size = 'default',
  loading = false,
  className,
  'data-name': dataName,
}: EmptyStateProps) {
  const cls = [
    'app-empty-state',
    size === 'large' ? 'large' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} data-name={dataName}>
      {loading ? '加载中…' : message}
    </div>
  );
}
