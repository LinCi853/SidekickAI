/* =====================================================================
   ui/ConfirmDialog.tsx —— 共享确认对话框
   基于 Modal 构建，替代原生 confirm()。
   提供 primary / danger 两种确认按钮风格，支持异步确认（onConfirm 可返回 Promise）。
   ===================================================================== */

import { useState, type ReactNode } from 'react';
import Modal from './Modal';
import Button from './Button';

export interface ConfirmDialogProps {
  /** 是否显示 */
  open: boolean;
  /** 标题（默认「确认」） */
  title?: ReactNode;
  /** 提示消息 */
  message: ReactNode;
  /** 确认按钮文案（默认「确定」） */
  confirmLabel?: string;
  /** 取消按钮文案（默认「取消」） */
  cancelLabel?: string;
  /** 确认按钮风格：primary(默认) / danger(危险操作) */
  variant?: 'primary' | 'danger';
  /** 确认回调（可返回 Promise；进行中时按钮显示 loading 且禁用） */
  onConfirm: () => void | Promise<void>;
  /** 取消 / 关闭回调 */
  onCancel: () => void;
}

/**
 * 确认对话框 —— 替代原生 confirm()
 *
 * @example
 * <ConfirmDialog
 *   open={open}
 *   title="清空记录"
 *   message="确定要清空全部下载记录吗？此操作不会删除已下载的文件。"
 *   variant="danger"
 *   confirmLabel="清空"
 *   onConfirm={handleClear}
 *   onCancel={() => setOpen(false)}
 * />
 */
export default function ConfirmDialog({
  open,
  title = '确认',
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  variant = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const handleConfirm = () => {
    const ret = onConfirm();
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      setPending(true);
      (ret as Promise<void>).finally(() => setPending(false));
    }
  };

  return (
    <Modal open={open} onClose={onCancel} title={title} portal closeOnOverlayClick={!pending}>
      <div className="confirm-dialog" data-name="ui.confirm-dialog">
        <p className="confirm-dialog-message" data-name="ui.confirm-dialog.message">{message}</p>
        <div className="confirm-dialog-actions" data-name="ui.confirm-dialog.actions">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
            data-name="ui.confirm-dialog.cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={pending}
            data-name="ui.confirm-dialog.confirm"
          >
            {pending ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
