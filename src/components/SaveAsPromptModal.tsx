/* =====================================================================
   components/SaveAsPromptModal.tsx —— 存为提示词弹窗
   点击「存为提示词」后弹出，预填笔记内容，
   用户可修改标题/内容/分类/快捷键后保存为提示词模板。
   三方一致：复用 PromptEditorForm 共享表单 + prompt-editor 外壳样式。
   ===================================================================== */

import { useEffect, useState } from 'react';
import type { PromptTemplate } from '../lib/electron-api';
import { savePrompt } from '../lib/electron-api';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import PromptEditorForm from './PromptEditorForm';

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
  const [category, setCategory] = useState('');
  const [hotkey, setHotkey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时同步预填值（每次 open 从 false→true 时重置）
  useEffect(() => {
    if (open) {
      setTitle(initialTitle ?? '');
      setContent(initialContent);
      setCategory('');
      setHotkey('');
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
        hotkey: hotkey.trim() || undefined,
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
      className={`prompt-editor-overlay${open ? ' is-open' : ''}`}
      data-name="component.save-as-prompt.overlay"
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className="prompt-editor"
        role="dialog"
        aria-label="存为提示词"
        data-name="component.save-as-prompt.modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="prompt-editor-header" data-name="component.save-as-prompt.header">
          <h3 data-name="component.save-as-prompt.title">存为提示词</h3>
          <IconButton
            variant="close"
            className="prompt-editor-close"
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

        <PromptEditorForm
          title={title}
          content={content}
          category={category}
          hotkey={hotkey}
          editingId={null}
          onTitleChange={setTitle}
          onContentChange={setContent}
          onCategoryChange={setCategory}
          onHotkeyChange={setHotkey}
          dataNamePrefix="component.save-as-prompt"
        />

        {error && (
          <div
            style={{
              color: 'var(--danger, #ef4444)',
              fontSize: 'var(--text-sm)',
              padding: '0 var(--space-4)',
            }}
            data-name="component.save-as-prompt.error"
          >
            {error}
          </div>
        )}

        <div className="prompt-editor-footer" data-name="component.save-as-prompt.footer">
          <span
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
            data-name="component.save-as-prompt.meta"
          >
            {content.length} 字
          </span>
          <div className="prompt-editor-actions" data-name="component.save-as-prompt.actions">
            <Button
              variant="outline"
              className="prompt-btn"
              data-name="component.save-as-prompt.cancel-button"
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              variant="primary-compact"
              className="prompt-btn"
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
