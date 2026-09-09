/* =====================================================================
   pages/components/NotesEditor.tsx —— 灵感笔记编辑器展示组件
   markdown 编辑器 + 标题 + 标签 + 置顶 + 工具栏
   ===================================================================== */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Note } from '../../../electron/shared/types.js';
import { EmptyState } from '../../components/ui';
import { useNotesEditor } from '../hooks/useNotesEditor.js';

interface NotesEditorProps {
  note: Note | null;
  onContentChange: (content: string, contentJson: string) => void;
  onTogglePin: () => void;
  onTagsChange: (tags: string[]) => void;
  onSendToAi: () => void;
  onSaveAsPrompt: () => void;
}

export default function NotesEditor({
  note,
  onContentChange,
  onTogglePin,
  onTagsChange,
  onSendToAi,
  onSaveAsPrompt,
}: NotesEditorProps) {
  const [tagInput, setTagInput] = useState('');
  const {
    markdownText,
    mode,
    setMode,
    textareaRef,
    handleContentChange,
    insertSyntax,
    insertLinePrefix,
    handleKeyDown,
    handlePaste,
    handleDrop,
    saveCursorPosition,
  } = useNotesEditor(note, onContentChange);

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    const currentTags = note?.tags ?? [];
    if (!currentTags.includes(tag)) {
      onTagsChange([...currentTags, tag]);
    }
    setTagInput('');
  };

  const handleRemoveTag = (tag: string) => {
    const currentTags = note?.tags ?? [];
    onTagsChange(currentTags.filter((t) => t !== tag));
  };

  if (!note) {
    return (
      <div className="notes-editor-empty" data-name="advanced-panel.notes-editor-empty">
        <EmptyState message="选择或新建一条笔记" className="notes-editor-empty-text" data-name="advanced-panel.notes-editor-empty-text" />
      </div>
    );
  }

  return (
    <div className="notes-editor" data-name="advanced-panel.notes-editor">
      <div className="notes-editor-toolbar-top" data-name="advanced-panel.notes-editor-toolbar-top">
        <div className="notes-tags-row" data-name="advanced-panel.notes-editor-tags-row">
          {note.tags.map((tag, idx) => (
            <span key={tag} className="notes-tag-chip removable" data-name={`advanced-panel.notes-editor-tag-${idx + 1}`} data-tag={tag}>
              {tag}
              <button className="notes-tag-remove" onClick={() => handleRemoveTag(tag)} aria-label={`移除标签 ${tag}`} data-name={`advanced-panel.notes-editor-tag-${idx + 1}-remove`}>×</button>
            </span>
          ))}
          <input
            type="text"
            className="notes-tag-input"
            placeholder="添加标签…"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddTag();
            }}
            onBlur={handleAddTag}
            data-name="advanced-panel.notes-editor-tag-input"
          />
        </div>
        <div className="notes-editor-actions" data-name="advanced-panel.notes-editor-actions">
          <button
            className={`btn-icon ${note.pinned ? 'is-active' : ''}`}
            onClick={onTogglePin}
            title={note.pinned ? '取消置顶' : '置顶'}
            aria-pressed={note.pinned}
            aria-label={note.pinned ? '取消置顶' : '置顶'}
            data-name="advanced-panel.notes-editor-pin-button"
          >
            ★
          </button>
        </div>
      </div>

      <div className="notes-toolbar" data-name="advanced-panel.notes-toolbar">
        <button
          className="btn-icon"
          onClick={() => setMode(mode === 'source' ? 'preview' : 'source')}
          title={mode === 'source' ? '查看预览' : '查看源码'}
          aria-label={mode === 'source' ? '查看预览' : '查看源码'}
          data-name="advanced-panel.notes-toolbar-mode-toggle"
        >
          {mode === 'source' ? '👁' : '</>'}
        </button>
        <button
          className="btn-icon"
          onClick={() => insertSyntax('**', '**', '粗体')}
          title="加粗"
          aria-label="加粗"
          data-name="advanced-panel.notes-toolbar-bold-button"
        >
          B
        </button>
        <button
          className="btn-icon"
          onClick={() => insertSyntax('*', '*', '斜体')}
          title="斜体"
          aria-label="斜体"
          data-name="advanced-panel.notes-toolbar-italic-button"
        >
          I
        </button>
        <button
          className="btn-icon"
          onClick={() => insertLinePrefix('## ')}
          title="标题"
          aria-label="标题"
          data-name="advanced-panel.notes-toolbar-heading-button"
        >
          H
        </button>
        <button
          className="btn-icon"
          onClick={() => insertLinePrefix('- ')}
          title="无序列表"
          aria-label="无序列表"
          data-name="advanced-panel.notes-toolbar-bullet-list-button"
        >
          •
        </button>
        <button
          className="btn-icon"
          onClick={() => insertLinePrefix('- [ ] ')}
          title="任务列表"
          aria-label="任务列表"
          data-name="advanced-panel.notes-toolbar-task-list-button"
        >
          ☑
        </button>
        <button
          className="btn-icon"
          onClick={() => insertSyntax('\n```\n', '\n```\n', '代码')}
          title="代码块"
          aria-label="代码块"
          data-name="advanced-panel.notes-toolbar-code-block-button"
        >
          {'</>'}
        </button>
      </div>

      <div className="notes-editor-body" data-name="advanced-panel.notes-editor-body">
        {mode === 'source' ? (
          <textarea
            ref={textareaRef}
            className="notes-markdown-textarea"
            value={markdownText}
            spellCheck={false}
            placeholder="记录你的灵感…（支持 Markdown 语法）"
            onChange={(e) => handleContentChange(e.target.value)}
            onSelect={saveCursorPosition}
            onClick={saveCursorPosition}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onKeyDown={handleKeyDown}
            data-name="advanced-panel.notes-markdown-textarea"
          />
        ) : (
          <div className="notes-markdown-preview" data-name="advanced-panel.notes-markdown-preview">
            {markdownText.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {markdownText}
              </ReactMarkdown>
            ) : (
              <EmptyState message={<>记录你的灵感…（点击 {'</>'} 切换到源码编辑）</>} className="notes-editor-empty-text" />
            )}
          </div>
        )}
      </div>

      <div className="notes-bottom" data-name="advanced-panel.notes-bottom">
        <span className="notes-char-count" data-name="advanced-panel.notes-char-count">
          {markdownText.length} 字
        </span>
        <div className="notes-bottom-actions" data-name="advanced-panel.notes-bottom-actions">
          <button className="btn-outline btn-text" onClick={onSaveAsPrompt} data-name="advanced-panel.notes-save-as-prompt-button">
            存为提示词
          </button>
          <button className="btn-primary-flat" onClick={onSendToAi} data-name="advanced-panel.notes-send-to-ai-button">
            发送到 AI
          </button>
        </div>
      </div>
    </div>
  );
}
