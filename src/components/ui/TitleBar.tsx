/* =====================================================================
   ui/TitleBar.tsx —— 通用窗口顶栏组件
   统一 Standalone / Chat / AiApp 三个独立窗口的标题栏样式（毛玻璃风格）
   三段式布局：leading | center(拖拽区) | actions | WindowControls
   ===================================================================== */

import type { ReactNode } from 'react';
import WindowControls from './WindowControls';
import './TitleBar.css';

export interface TitleBarProps {
  /** 左侧内容（如 Chat 的侧边栏切换按钮） */
  leading?: ReactNode;
  /** 中间拖拽区内容（标题、标签栏等，整个区域可拖拽，内部交互元素需自行 no-drag） */
  center?: ReactNode;
  /** 右侧业务按钮（设置、置顶、导航等，不含窗口控制三件套） */
  actions?: ReactNode;
  /** 最小化回调（不传则不渲染最小化按钮） */
  onMinimize?: () => void;
  /** 最大化/还原回调（不传则不渲染最大化按钮） */
  onMaximize?: () => void;
  /** 关闭回调（不传则不渲染关闭按钮） */
  onClose?: () => void;
  /** 是否已最大化（影响最大化图标显示：最大化 vs 还原） */
  maximized?: boolean;
  /** 附加类名 */
  className?: string;
}

/** 最大化图标（方框） */
function MaximizeIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

/** 还原图标（四个角） */
function RestoreIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/** 最小化图标（横线） */
function MinimizeIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** 关闭图标（X） */
function CloseIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/**
 * 通用窗口顶栏 —— 统一毛玻璃风格 + WindowControls 三件套
 *
 * @example
 * <TitleBar
 *   center={<SegmentedControl ... />}
 *   actions={<><SettingsButton /><PinButton /></>}
 *   maximized={isMaximized}
 *   onMinimize={handleMinimize}
 *   onMaximize={handleMaximize}
 *   onClose={handleClose}
 * />
 */
export default function TitleBar({
  leading,
  center,
  actions,
  onMinimize,
  onMaximize,
  onClose,
  maximized = false,
  className,
}: TitleBarProps) {
  return (
    <div className={`titlebar${className ? ` ${className}` : ''}`} data-name="ui.titlebar">
      {leading && <div className="titlebar-leading" data-name="ui.titlebar.leading">{leading}</div>}
      <div className="titlebar-drag" data-name="ui.titlebar.drag-area">
        {center}
      </div>
      {actions && <div className="titlebar-actions" data-name="ui.titlebar.actions">{actions}</div>}
      <WindowControls
        onMinimize={onMinimize}
        onMaximize={onMaximize}
        onClose={onClose}
        minimizeIcon={<MinimizeIcon />}
        maximizeIcon={maximized ? <RestoreIcon /> : <MaximizeIcon />}
        closeIcon={<CloseIcon />}
      />
    </div>
  );
}
