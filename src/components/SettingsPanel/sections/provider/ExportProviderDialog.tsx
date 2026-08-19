/* =====================================================================
   SettingsPanel/sections/provider/ExportProviderDialog —— 加密导出对话框
   从 ProviderSection.tsx 拆出（Modal 替代原 .provider-form-overlay）。
   ===================================================================== */

import { Modal, FormRow, Button } from '../../../ui';

/** 加密导出/导入的反馈信息 */
export interface CryptoFeedback {
  type: 'success' | 'error';
  msg: string;
}

interface ExportProviderDialogProps {
  open: boolean;
  /** 选中导出的 provider 数量 */
  selectedCount: number;
  /** provider 总数（用于「导出全部」提示文案） */
  totalCount: number;
  password: string;
  onPasswordChange: (value: string) => void;
  exporting: boolean;
  feedback: CryptoFeedback | null;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ExportProviderDialog({
  open,
  selectedCount,
  totalCount,
  password,
  onPasswordChange,
  exporting,
  feedback,
  onClose,
  onConfirm,
}: ExportProviderDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => !exporting && onClose()}
      title="加密导出"
      className="provider-crypto-modal"
      data-name="advanced-panel.export-dialog"
    >
      <p className="provider-form-dialog-desc" data-name="advanced-panel.export-dialog-desc">
        {selectedCount > 0
          ? `导出 ${selectedCount} 个 Provider 到 .sapp 文件，输入加密密码。`
          : `导出全部 ${totalCount} 个 Provider 到 .sapp 文件，输入加密密码。`}
      </p>
      <FormRow label="加密密码" compact data-name="advanced-panel.export-dialog-password-row">
        <input
          type="password"
          className="provider-form-input"
          placeholder="输入密码"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          autoFocus
          autoComplete="off"
          data-name="advanced-panel.export-dialog-password-input"
        />
      </FormRow>
      {feedback && (
        <div className={`provider-test-result ${feedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.export-dialog-feedback">
          {feedback.msg}
        </div>
      )}
      <div className="provider-form-actions" data-name="advanced-panel.export-dialog-actions">
        <Button
          type="button"
          variant="outline"
          className="provider-form-btn"
          disabled={exporting}
          onClick={onClose}
          data-name="advanced-panel.export-dialog-cancel-button"
        >
          取消
        </Button>
        <Button
          type="button"
          variant="primary-flat"
          className="provider-form-btn"
          disabled={!password.trim() || exporting}
          onClick={() => void onConfirm()}
          data-name="advanced-panel.export-dialog-confirm-button"
        >
          {exporting ? '导出中…' : '确认导出'}
        </Button>
      </div>
    </Modal>
  );
}
