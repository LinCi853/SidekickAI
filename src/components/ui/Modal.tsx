/* =====================================================================
   ui/Modal.tsx —— 模态容器组件
   依赖 globals.css 的 .modal-overlay / .modal-container 全局类
   替代 ShortcutsModal / PromptLibrary / PromptLibraryView / SettingsPanel 容器
   ===================================================================== */

import type { HTMLAttributes, ReactNode } from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import IconButton from './IconButton';
import { pushOverlay, isTopOverlay } from '../../hooks/useEscToCloseWindow';

export interface ModalProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 是否显示 */
  open: boolean;
  /** 关闭回调（点击遮罩或关闭按钮触发） */
  onClose?: () => void;
  /** 标题（渲染在头部） */
  title?: ReactNode;
  /** 是否显示关闭按钮（默认 true） */
  showCloseButton?: boolean;
  /** 关闭按钮的 aria-label */
  closeLabel?: string;
  /** 自定义关闭按钮内容 */
  closeIcon?: ReactNode;
  /** 是否点击遮罩关闭（默认 true） */
  closeOnOverlayClick?: boolean;
  /** 是否按 Esc 关闭（默认 true） */
  closeOnEscape?: boolean;
  /**
   * 是否通过 Portal 渲染到 document.body（默认 false）。
   *
   * 用途：当 Modal 的祖先元素有 CSS transform（如侧滑面板的 translateX）时，
   * `position: fixed` 的包含块会变为该祖先元素而非视口，导致 Modal 定位异常。
   * 启用 portal 后 Modal 渲染到 document.body，脱离 transform 祖先的影响，
   * 确保全屏遮罩正确覆盖整个视口。
   */
  portal?: boolean;
  /** 内容 */
  children: ReactNode;
}

/**
 * 模态容器 —— 统一弹窗结构（遮罩 + 容器 + 头部 + 内容）
 *
 * @example
 * <Modal open={isOpen} onClose={close} title="快捷键">
 *   <div>...内容...</div>
 * </Modal>
 */
export default function Modal({
  open,
  onClose,
  title,
  showCloseButton = true,
  closeLabel = '关闭',
  closeIcon,
  closeOnOverlayClick = true,
  closeOnEscape = true,
  portal = false,
  className,
  children,
  ...rest
}: ModalProps) {
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const close = () => onClose?.();
    const removeFromStack = pushOverlay(close);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只有栈顶的 Modal 处理 ESC（后打开的优先）
      if (!isTopOverlay(close)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      removeFromStack();
    };
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  const content = (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (closeOnOverlayClick && e.target === e.currentTarget) onClose?.();
      }}
      data-name="ui.modal.overlay"
    >
      <div
        className={['modal-container', className].filter(Boolean).join(' ')}
        {...rest}
      >
        {(title || showCloseButton) && (
          <div className="modal-header" data-name="ui.modal.header">
            {title && <h2 className="modal-title" data-name="ui.modal.title">{title}</h2>}
            {showCloseButton && (
              <IconButton aria-label={closeLabel} variant="close" onClick={onClose} data-name="ui.modal.close-icon-button">
                {closeIcon ?? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" data-name="ui.modal.close-icon">
                    <path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                )}
              </IconButton>
            )}
          </div>
        )}
        <div className="modal-body" data-name="ui.modal.body">
          {children}
        </div>
      </div>
    </div>
  );

  // Portal 模式：渲染到 document.body，脱离祖先 transform 的影响
  // 用于侧滑面板内嵌的 Modal（如供应商编辑），确保 fixed 定位相对于视口
  if (portal && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }
  return content;
}
