/* =====================================================================
   components/SidebarShell.tsx —— 通用侧边栏壳组件
   统一：收起态图标栏 / 可拖拽宽度 / 底栏（设置+收起）/ 列表区
   ===================================================================== */

import type { ReactNode } from 'react';
import { IconButton } from './ui';
import { GearIcon } from './icons';
import SidebarResizer from './SidebarResizer';
import './SidebarShell.css';

/** 收起态可点击条目 */
export interface SidebarCollapsedItem {
  /** 唯一标识 */
  id: string;
  /** 显示文字（取首字符作为图标） */
  label: string;
  /** 是否为当前激活项 */
  active?: boolean;
  /** 点击回调 */
  onClick: () => void;
}

export interface SidebarShellProps {
  /** 是否收起 */
  collapsed: boolean;
  /** 当前宽度（未收起时） */
  width: number;
  /** 拖拽调宽回调 */
  onResize: (w: number) => void;
  /** 收起/展开切换 */
  onToggleCollapse: () => void;
  /** 打开设置回调 */
  onOpenSettings?: () => void;
  /** 新建按钮点击 */
  onNew?: () => void;
  /** 新建按钮提示文字 */
  newTitle?: string;
  /** 收起态可点击条目列表（笔记/对话等，收起时显示） */
  collapsedItems?: SidebarCollapsedItem[];
  /** 收起态顶部额外内容（如模型选择器，收起时显示在新建按钮下方） */
  collapsedHeader?: ReactNode;
  /** 侧边栏头部内容（搜索框、标签筛选等，收起时隐藏） */
  header?: ReactNode;
  /** 列表内容（收起时隐藏） */
  children?: ReactNode;
  /** data-name 前缀 */
  dataName?: string;
}

export default function SidebarShell({
  collapsed,
  width,
  onResize,
  onToggleCollapse,
  onOpenSettings,
  onNew,
  newTitle = '新建',
  collapsedItems,
  collapsedHeader,
  header,
  children,
  dataName = 'sidebar',
}: SidebarShellProps) {
  return (
    <aside
      className={`sidebar-shell${collapsed ? ' is-collapsed' : ''}`}
      style={collapsed ? undefined : { width: `${width}px`, flex: 'none' }}
      data-name={`${dataName}.shell`}
    >
      {/* 收起态：竖排图标栏 */}
      {collapsed && (
        <div className="sidebar-shell-collapsed-bar" data-name={`${dataName}.collapsed-bar`}>
          {onNew && (
            <IconButton
              type="button"
              className="sidebar-shell-collapsed-btn"
              onClick={onNew}
              title={newTitle}
              aria-label={newTitle}
              data-name={`${dataName}.collapsed-new`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </IconButton>
          )}
          {/* 收起态额外头部内容（如模型选择器） */}
          {collapsedHeader}
          {/* 收起态可点击条目列表 */}
          {collapsedItems && collapsedItems.length > 0 && (
            <div className="sidebar-shell-collapsed-items" data-name={`${dataName}.collapsed-items`}>
              {collapsedItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-shell-collapsed-item${item.active ? ' active' : ''}`}
                  onClick={item.onClick}
                  title={item.label}
                  data-name={`${dataName}.collapsed-item-${item.id}`}
                >
                  {item.label.charAt(0)}
                </button>
              ))}
            </div>
          )}
          <div className="sidebar-shell-collapsed-spacer" />
          {onOpenSettings && (
            <IconButton
              type="button"
              className="sidebar-shell-collapsed-btn"
              onClick={onOpenSettings}
              title="设置"
              aria-label="设置"
              data-name={`${dataName}.collapsed-settings`}
            >
              <GearIcon />
            </IconButton>
          )}
          <IconButton
            type="button"
            className="sidebar-shell-collapsed-btn"
            onClick={onToggleCollapse}
            title="展开侧边栏"
            aria-label="展开侧边栏"
            data-name={`${dataName}.collapsed-expand`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </IconButton>
        </div>
      )}

      {/* 头部（搜索、新建按钮等） */}
      {header}

      {/* 列表内容 */}
      {children}

      {/* 底栏：设置 + 收起（嵌入列表底部） */}
      <div className="sidebar-shell-footer" data-name={`${dataName}.footer`}>
        {onOpenSettings && (
          <IconButton
            type="button"
            className="sidebar-shell-footer-btn"
            onClick={onOpenSettings}
            title="设置"
            aria-label="设置"
            data-name={`${dataName}.footer-settings`}
          >
            <GearIcon />
          </IconButton>
        )}
        <IconButton
          type="button"
          className="sidebar-shell-footer-btn"
          onClick={onToggleCollapse}
          title="收起侧边栏"
          aria-label="收起侧边栏"
          data-name={`${dataName}.footer-collapse`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </svg>
        </IconButton>
      </div>

      {/* 拖拽调宽手柄 */}
      {!collapsed && <SidebarResizer width={width} minWidth={120} maxWidth={400} onResize={onResize} />}
    </aside>
  );
}
