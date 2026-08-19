/* =====================================================================
   SettingsPanel/sections/provider/ImportProviderDialog —— 加密导入对话框
   从 ProviderSection.tsx 拆出（文件选择 → 密码 → 预览 → 确认；Modal 替代原 .provider-form-overlay）。
   ===================================================================== */

import { Modal, FormRow, Button } from '../../../ui';
import type { CryptoFeedback } from './ExportProviderDialog.js';

/** v0.5.2 B-4：导入预览（dry-run，不持久化）结果 */
export interface ImportPreview {
  providers: Array<{
    id: string;
    name: string;
    protocol: string;
    apiEndpoint: string;
    model: string;
    alternativeModels?: string[];
  }>;
  conflictIds: string[];
}

interface ImportProviderDialogProps {
  open: boolean;
  importing: boolean;
  importFilePath: string;
  importPassword: string;
  importPreview: ImportPreview | null;
  feedback: CryptoFeedback | null;
  onClose: () => void;
  onSelectFile: () => void;
  onPasswordChange: (value: string) => void;
  onPreview: () => void;
  onConfirm: () => void;
  onBack: () => void;
}

export default function ImportProviderDialog({
  open,
  importing,
  importFilePath,
  importPassword,
  importPreview,
  feedback,
  onClose,
  onSelectFile,
  onPasswordChange,
  onPreview,
  onConfirm,
  onBack,
}: ImportProviderDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => !importing && onClose()}
      title="加密导入"
      className="provider-crypto-modal"
      data-name="advanced-panel.import-dialog"
    >
      {!importPreview ? (
        <>
          <p className="provider-form-dialog-desc" data-name="advanced-panel.import-dialog-step1-desc">
            选择 .sapp 文件并输入密码。
          </p>
          <FormRow label="文件" compact data-name="advanced-panel.import-dialog-file-row">
            <div className="provider-import-file-row">
              <input
                type="text"
                className="provider-form-input"
                value={importFilePath}
                readOnly
                placeholder="选择 .sapp 文件..."
                data-name="advanced-panel.import-dialog-file-input"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void onSelectFile()}
                data-name="advanced-panel.import-dialog-select-file-button"
              >
                选择文件
              </Button>
            </div>
          </FormRow>
          <FormRow label="解密密码" compact data-name="advanced-panel.import-dialog-password-row">
            <input
              type="password"
              className="provider-form-input"
              placeholder="输入密码"
              value={importPassword}
              onChange={(e) => onPasswordChange(e.target.value)}
              autoComplete="off"
              data-name="advanced-panel.import-dialog-password-input"
            />
          </FormRow>
          {feedback && (
            <div className={`provider-test-result ${feedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.import-dialog-step1-feedback">
              {feedback.msg}
            </div>
          )}
          <div className="provider-form-actions" data-name="advanced-panel.import-dialog-step1-actions">
            <Button
              type="button"
              variant="outline"
              className="provider-form-btn"
              disabled={importing}
              onClick={onClose}
              data-name="advanced-panel.import-dialog-cancel-button"
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary-flat"
              className="provider-form-btn"
              disabled={!importFilePath || !importPassword.trim() || importing}
              onClick={() => void onPreview()}
              data-name="advanced-panel.import-dialog-preview-button"
            >
              {importing ? '解析中…' : '预览'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="provider-form-dialog-desc" data-name="advanced-panel.import-dialog-step2-desc">
            导入 {importPreview.providers.length} 个 Provider，其中 {importPreview.conflictIds.length} 个覆盖现有配置。
          </p>
          <div className="provider-import-preview-list" data-name="advanced-panel.import-dialog-preview-list">
            {importPreview.providers.map((p, idx) => {
              const isConflict = importPreview.conflictIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  className={`provider-import-preview-item ${isConflict ? 'conflict' : 'new'}`}
                  data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}`}
                  data-index={idx + 1}
                  data-id={p.id}
                >
                  <span className="provider-import-preview-name" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-name`}>{p.name}</span>
                  <span className="provider-import-preview-meta" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-meta`}>{p.protocol} · {p.model}</span>
                  <span className="provider-import-preview-tag" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-tag`}>
                    {isConflict ? '覆盖' : '新增'}
                  </span>
                </div>
              );
            })}
          </div>
          {feedback && (
            <div className={`provider-test-result ${feedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.import-dialog-step2-feedback">
              {feedback.msg}
            </div>
          )}
          <div className="provider-form-actions" data-name="advanced-panel.import-dialog-step2-actions">
            <Button
              type="button"
              variant="outline"
              className="provider-form-btn"
              disabled={importing}
              onClick={onBack}
              data-name="advanced-panel.import-dialog-back-button"
            >
              返回
            </Button>
            <Button
              type="button"
              variant="primary-flat"
              className="provider-form-btn"
              disabled={importing}
              onClick={() => void onConfirm()}
              data-name="advanced-panel.import-dialog-confirm-button"
            >
              {importing ? '导入中…' : '确认导入'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
