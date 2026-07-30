/* =====================================================================
   components/SaveAsPromptModal.tsx —— 存为提示词遮罩
   点击「存为提示词」后弹出覆盖应用的遮罩，预填笔记内容，
   用户可再次修改标题/内容/分类后保存为提示词模板。
   复用 InjectionPreviewModal 的遮罩样式与 ESC 关闭逻辑。
   ===================================================================== */

import { useEffect, useState } from 'react';
import type { PromptTemplate } from '../lib/electron-api';
import { savePrompt } from '../lib/electron-api';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import './InjectionPreviewModal.css';

export interface SaveAsPromptModalProps {
  /** 是否打开 */
  open: boolean;
  /** 预填充内容（笔记正文） */
  initialContent: string;
  /** 预填充标题（笔记标题，可选） */
  initialTitle?: string;
  /** 保存成功回调 */
  onSaved: () => void;
  /** 取消/关闭回调 */
  onClose: () => void;
}

export default function SaveAsPromptModal({
  open,
  initialContent,
  initialTitle,
  onSaved,
  onClose,
}: SaveAsPromptModalProps) {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [content, setContent] = useState(initialContent);
  const [category, setCategory] = useState('笔记');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时同步预填值（每次 open 从 false→true 时重置）
  useEffect(() => {
    if (open) {
      setTitle(initialTitle ?? '');
      setContent(initialContent);
      setCategory('笔记');
      setError(null);
      setSaving(false);
    }
  }, [open, initialContent, initialTitle]);

  // ESC 关闭（走统一浮窗栈）
  useEscToCloseOverlay(open, onClose);

  if (!open) return null;

  const handleConfirm = async () => {
    if (!content.trim()) {
      setError('内容不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const template: PromptTemplate = {
        id: crypto.randomUUID(),
        title: title.trim() || content.slice(0, 30),
        content: content.trim(),
        category: category.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };
      await savePrompt(template);
      onSaved();
    } catch (e) {
      console.error('[SaveAsPromptModal] 保存失败:', e);
      setError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="injection-preview-overlay is-open"
      data-name="component.save-as-prompt.overlay"
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className="injection-preview-modal"
        role="dialog"
        aria-label="存为提示词"
        data-name="component.save-as-prompt.modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="injection-preview-header" data-name="component.save-as-prompt.header">
          <h3 data-name="component.save-as-prompt.title">存为提示词</h3>
          <IconButton
            variant="close"
            className="injection-preview-close"
            data-name="component.save-as-prompt.close-button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <svg
              className="icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              data-name="component.save-as-prompt.close-icon"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </IconButton>
        </div>

        <div className="injection-preview-body" data-name="component.save-as-prompt.body">
          <input
            type="text"
            className="injection-preview-textarea"
            style={{ minHeight: 'auto', maxHeight: 'none', padding: 'var(--space-2) var(--space-3)' }}
            value={title}
            placeholder="标题（可选，留空则取内容前 30 字）"
            data-name="component.save-as-prompt.title-input"
            spellCheck={false}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="text"
            className="injection-preview-textarea"
            style={{ minHeight: 'auto', maxHeight: 'none', padding: 'var(--space-2) var(--space-3)' }}
            value={category}
            placeholder="分类（可选）"
            data-name="component.save-as-prompt.category-input"
            spellCheck={false}
            onChange={(e) => setCategory(e.target.value)}
          />
          <textarea
            className="injection-preview-textarea"
            value={content}
            data-name="component.save-as-prompt.content-textarea"
            spellCheck={false}
            autoFocus
            placeholder="提示词内容"
            onChange={(e) => setContent(e.target.value)}
          />
          {error && (
            <div
              style={{ color: 'var(--danger, #ef4444)', fontSize: 'var(--text-sm)' }}
              data-name="component.save-as-prompt.error"
            >
              {error}
            </div>
          )}
        </div>

        <div className="injection-preview-footer" data-name="component.save-as-prompt.footer">
          <span className="injection-preview-meta" data-name="component.save-as-prompt.meta">
            {content.length} 字
          </span>
          <div className="injection-preview-actions" data-name="component.save-as-prompt.actions">
            <Button
              variant="outline"
              className="injection-preview-btn"
              data-name="component.save-as-prompt.cancel-button"
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              variant="primary-compact"
              className="injection-preview-btn"
              data-name="component.save-as-prompt.confirm-button"
              disabled={saving}
              onClick={() => void handleConfirm()}
            >
              {saving ? '保存中…' : '确认保存'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
