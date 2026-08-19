/* =====================================================================
   components/StandaloneWindowHeader.tsx —— 独立窗口通用顶栏
   封装 TitleBar + 常用的「标题 + 置顶 + 最小化/最大化/关闭」组合，
   内部管理 isPinned / isMaximized 状态与 IPC 订阅，
   消除各独立窗口（History / Prompt / Onboarding 等）的重复样板。
   ===================================================================== */

import { type ReactNode } from 'react';
import { TitleBar, IconButton, PinToggleButton } from '@/components/ui';
import { GearIcon } from '@/components/icons';
import {
  minimizeWindow,
  closeCurrentWindow,
} from '@/lib/electron-api';
import { useWindowMaximizedAndPinned } from '@/hooks/useWindowMaximizedAndPinned';
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
  const { isMaximized, isPinned, handleMaximize, handleTogglePin } = useWindowMaximizedAndPinned();

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
              <GearIcon className="icon-svg" />
            </IconButton>
          )}
          {showPinButton && (
            <PinToggleButton
              isPinned={isPinned}
              onToggle={handleTogglePin}
              data-name={`${dataNamePrefix}.pin-button`}
            />
          )}
        </>
      }
      className={className}
    />
  );
}
