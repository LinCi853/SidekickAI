/* =====================================================================
   components/StandaloneWindowHeader.tsx —— 独立窗口通用顶栏
   封装 TitleBar + 常用的「标题 + 置顶 + 最小化/最大化/关闭」组合，
   内部管理 isPinned / isMaximized 状态与 IPC 订阅，
   消除各独立窗口（History / Prompt / Onboarding 等）的重复样板。
   ===================================================================== */

import { useEffect, useState, type ReactNode } from 'react';
import { TitleBar, IconButton } from '@/components/ui';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onMaximizeToggled,
  onPinToggled,
} from '@/lib/electron-api';
import './StandaloneWindowHeader.css';

export interface StandaloneWindowHeaderProps {
  /** 窗口标题；当未传入 center 时作为默认标题渲染 */
  title: string;
  /** 覆盖默认 center（标题）。传入后替换默认标题节点 */
  center?: ReactNode;
  /** 左侧内容（如侧边栏切换按钮） */
  leading?: ReactNode;
  /** 额外的 action 按钮，渲染在置顶按钮之前 */
  actions?: ReactNode;
  /** 设置按钮回调；传入则渲染齿轮设置按钮 */
  onOpenSettings?: () => void;
  /** 是否显示置顶按钮，默认 true */
  showPinButton?: boolean;
  /** 是否显示最小化/最大化按钮，默认 true；仅含关闭按钮的窗口（如引导页）传 false */
  showMinMax?: boolean;
  /** 埋点 data-name 前缀，默认 'window' */
  dataNamePrefix?: string;
  /** 附加类名（透传给 TitleBar） */
  className?: string;
}

/**
 * 独立窗口通用顶栏 —— 统一「标题 + 置顶 + 窗口控制」组合。
 *
 * @example
 * // 简单标题 + 置顶 + 窗口控制
 * <StandaloneWindowHeader title="提示词库" dataNamePrefix="prompts.topbar" />
 *
 * @example
 * // 仅标题 + 关闭（引导页）
 * <StandaloneWindowHeader title="使用指南" showPinButton={false} showMinMax={false} />
 */
export default function StandaloneWindowHeader({
  title,
  center,
  leading,
  actions,
  onOpenSettings,
  showPinButton = true,
  showMinMax = true,
  dataNamePrefix = 'window',
  className,
}: StandaloneWindowHeaderProps) {
  const [isPinned, setIsPinned] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // 初始化置顶/最大化状态
  useEffect(() => {
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
    void isWindowMaximized().then(setIsMaximized).catch(() => {});
  }, []);

  // 订阅主进程状态广播（F12 拦截、其他入口触发时同步）
  useEffect(() => {
    const offPin = onPinToggled((onTop) => setIsPinned(onTop));
    const offMax = onMaximizeToggled((max) => setIsMaximized(max));
    return () => { offPin(); offMax(); };
  }, []);

  const handleTogglePin = async () => {
    const next = !isPinned;
    setIsPinned(next);
    await pinCurrentWindow(next);
  };

  const handleMaximize = async () => {
    const next = await maximizeToggleWindow();
    setIsMaximized(next);
  };

  return (
    <TitleBar
      maximized={isMaximized}
      onMinimize={showMinMax ? () => void minimizeWindow() : undefined}
      onMaximize={showMinMax ? handleMaximize : undefined}
      onClose={() => void closeCurrentWindow()}
      leading={leading}
      center={
        center ?? (
          <span className="sw-header-title" data-name={`${dataNamePrefix}.title`}>
            {title}
          </span>
        )
      }
      actions={
        <>
          {actions}
          {onOpenSettings && (
            <IconButton
              type="button"
              onClick={onOpenSettings}
              title="设置"
              aria-label="设置"
              data-name={`${dataNamePrefix}.settings-button`}
            >
              <svg
                className="icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                data-name={`${dataNamePrefix}.settings-icon`}
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </IconButton>
          )}
          {showPinButton && (
            <IconButton
              type="button"
              variant={isPinned ? 'active' : 'default'}
              onClick={handleTogglePin}
              title={isPinned ? '取消置顶' : '置顶'}
              aria-label={isPinned ? '取消置顶' : '置顶'}
              data-name={`${dataNamePrefix}.pin-button`}
            >
              <svg
                className="icon-svg"
                viewBox="0 0 24 24"
                fill={isPinned ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                data-name={`${dataNamePrefix}.pin-icon`}
              >
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
          )}
        </>
      }
      className={className}
    />
  );
}
