/* =====================================================================
   ui/Modal.tsx —— 模态容器组件
   依赖 globals.css 的 .modal-overlay / .modal-container 全局类
   替代 ShortcutsModal / PromptLibrary / PromptLibraryView / SettingsPanel 容器
   ===================================================================== */

import type { HTMLAttributes, ReactNode } from 'react';
import { useEffect } from 'react';
import IconButton from './IconButton';

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
  className,
  children,
  ...rest
}: ModalProps) {
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return (
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
              <IconButton aria-label={closeLabel} variant="default" onClick={onClose} data-name="ui.modal.close-icon-button">
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
}
