/* =====================================================================
   components/InjectionPreviewModal.tsx —— 注入预览浮层（需求 2）
   需求 2：注入前弹出浮层预览完整提示词，可编辑；
          智能判断与最近 N 条已注入提示词的相似度，超过阈值提醒"重复添加，是否继续"。
   ===================================================================== */

import { useEffect, useState } from 'react';
import type { SimilarInjectionResult } from '../lib/electron-api';
import { formatTime } from '../lib/datetime';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import './InjectionPreviewModal.css';

export interface InjectionPreviewModalProps {
  /** 是否打开 */
  open: boolean;
  /** 预填充的可编辑文本（composeFinalText 的结果） */
  composedText: string;
  /** 相似度命中的最近注入记录（按相似度倒序），无则空数组 */
  similarRecords: SimilarInjectionResult[];
  /** 用户确认注入：传入编辑后的文本 */
  onConfirm: (editedText: string) => void;
  /** 用户取消 */
  onCancel: () => void;
}

export default function InjectionPreviewModal({
  open,
  composedText,
  similarRecords,
  onConfirm,
  onCancel,
}: InjectionPreviewModalProps) {
  const [editedText, setEditedText] = useState(composedText);

  // composedText 变化时（用户点击不同模板）同步到编辑框
  useEffect(() => {
    setEditedText(composedText);
  }, [composedText]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const hasSimilar = similarRecords.length > 0;
  // 显示最相似的一条作为提示
  const topSimilar = similarRecords[0];

  return (
    <div
      className={`injection-preview-overlay${open ? ' is-open' : ''}`}
      data-name="component.injection-preview.overlay"
      onClick={onCancel}
      aria-hidden={!open}
    >
      <div
        className="injection-preview-modal"
        role="dialog"
        aria-label="注入预览"
        data-name="component.injection-preview.modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="injection-preview-header" data-name="component.injection-preview.header">
          <h3 data-name="component.injection-preview.title">注入预览</h3>
          <IconButton
            variant="close"
            className="injection-preview-close"
            data-name="component.injection-preview.close-button"
            aria-label="关闭"
            title="关闭"
            onClick={onCancel}
          >
            <svg
              className="icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              data-name="component.injection-preview.close-icon"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </IconButton>
        </div>

        <div className="injection-preview-body" data-name="component.injection-preview.body">
          {hasSimilar && (
            <div
              className="injection-preview-warning"
              data-name="component.injection-preview.warning"
            >
              <span className="injection-preview-warning-icon" data-name="component.injection-preview.warning-icon">⚠</span>
              <span data-name="component.injection-preview.warning-text">
                与 {formatTime(topSimilar.createdAt)} 注入的内容相似度 ≥{' '}
                {(topSimilar.similarity * 100).toFixed(0)}%，是否继续？
              </span>
            </div>
          )}
          <textarea
            className="injection-preview-textarea"
            value={editedText}
            data-name="component.injection-preview.textarea"
            spellCheck={false}
            autoFocus
            placeholder="可编辑注入内容"
            onChange={(e) => setEditedText(e.target.value)}
          />
        </div>

        <div className="injection-preview-footer" data-name="component.injection-preview.footer">
          <span
            className="injection-preview-meta"
            data-name="component.injection-preview.meta"
          >
            {editedText.length} 字
          </span>
          <div className="injection-preview-actions" data-name="component.injection-preview.actions">
            <Button
              variant="text"
              className="injection-preview-btn"
              data-name="component.injection-preview.cancel-button"
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              variant="primary-compact"
              className="injection-preview-btn"
              data-name="component.injection-preview.confirm-button"
              onClick={() => onConfirm(editedText)}
            >
              确认注入
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
