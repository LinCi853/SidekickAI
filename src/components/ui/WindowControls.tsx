/* =====================================================================
   ui/WindowControls.tsx —— 窗口控制三件套（最小化/最大化/关闭）
   依赖 globals.css 的 .win-controls 容器类 + IconButton 组件
   替代 7 套 .win-btn / .chat-win-btn / .history-win-btn / .ai-app-win-btn / ... 复制
   ===================================================================== */

import type { ReactNode } from 'react';
import IconButton from './IconButton';

export interface WindowControlsProps {
  /** 最小化回调（不传则不渲染最小化按钮） */
  onMinimize?: () => void;
  /** 最大化/还原回调（不传则不渲染最大化按钮） */
  onMaximize?: () => void;
  /** 关闭回调（不传则不渲染关闭按钮） */
  onClose?: () => void;
  /** 最小化图标内容（默认使用 SVG） */
  minimizeIcon?: ReactNode;
  /** 最大化图标内容（默认使用 SVG） */
  maximizeIcon?: ReactNode;
  /** 关闭图标内容（默认使用 SVG） */
  closeIcon?: ReactNode;
  /** 是否禁用所有按钮 */
  disabled?: boolean;
}

/** 默认最小化图标（macOS 风格横线） */
function DefaultMinimizeIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      data-name="ui.window-controls.minimize-icon"
    >
      <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
    </svg>
  );
}

/** 默认最大化图标（macOS 风格三角） */
function DefaultMaximizeIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      data-name="ui.window-controls.maximize-icon"
    >
      <path d="M2 2 L8 2 L2 8 Z" fill="currentColor" />
    </svg>
  );
}

/** 默认关闭图标（macOS 风格 X） */
function DefaultCloseIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      data-name="ui.window-controls.close-icon"
    >
      <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 窗口控制三件套 —— 统一替代各窗口的 min/max/close 按钮组
 *
 * @example
 * <WindowControls
 *   onMinimize={() => window.electronAPI?.minimizeWindow()}
 *   onMaximize={() => window.electronAPI?.maximizeWindow()}
 *   onClose={() => window.electronAPI?.closeWindow()}
 * />
 */
export default function WindowControls({
  onMinimize,
  onMaximize,
  onClose,
  minimizeIcon,
  maximizeIcon,
  closeIcon,
  disabled = false,
}: WindowControlsProps) {
  return (
    <div className="win-controls" data-name="ui.window-controls.container">
      {onMinimize && (
        <IconButton
          aria-label="最小化"
          variant="default"
          disabled={disabled}
          onClick={onMinimize}
          data-name="ui.window-controls.minimize-button"
        >
          {minimizeIcon ?? <DefaultMinimizeIcon />}
        </IconButton>
      )}
      {onMaximize && (
        <IconButton
          aria-label="最大化"
          variant="default"
          disabled={disabled}
          onClick={onMaximize}
          data-name="ui.window-controls.maximize-button"
        >
          {maximizeIcon ?? <DefaultMaximizeIcon />}
        </IconButton>
      )}
      {onClose && (
        <IconButton
          aria-label="关闭"
          variant="close"
          disabled={disabled}
          onClick={onClose}
          data-name="ui.window-controls.close-button"
        >
          {closeIcon ?? <DefaultCloseIcon />}
        </IconButton>
      )}
    </div>
  );
}
