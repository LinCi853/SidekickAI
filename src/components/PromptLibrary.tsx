/* =====================================================================
   components/PromptLibrary.tsx —— 提示词模板库（明输入明注入）
   嵌入底栏展开面板：横向 chip 列表，单击注入到当前激活标签的 AI 输入框；
   「+」新增 / 右键编辑删除。注入由父组件通过 onInject 回调执行。
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PromptTemplate } from '../lib/electron-api';
import { usePromptStore } from '../store/usePromptStore';
import { useTabStore } from '../store/useTabStore';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import PromptEditorForm from './PromptEditorForm';
import './PromptLibrary.css';
import '../pages/PromptLibraryView.css';

export interface PromptLibraryProps {
  /** 注入模板到当前激活标签（需求 1：传递完整 PromptTemplate，由父组件组合后注入） */
  onInject?: (template: PromptTemplate) => Promise<{ success: boolean; platformName?: string }>;
  /** 可选：受控弹窗模式。传入 open 时以模态弹窗渲染，onClose 关闭弹窗 */
  open?: boolean;
  onClose?: () => void;
}

interface EditorState {
  open: boolean;
  editing: PromptTemplate | null;
  title: string;
  content: string;
  category: string;
  // 需求 2.5：局内快捷键
  hotkey: string;
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  editing: null,
  title: '',
  content: '',
  category: '',
  hotkey: '',
};

export default function PromptLibrary({ onInject, open, onClose }: PromptLibraryProps) {
  const prompts = usePromptStore((s) => s.prompts);
  const savePrompt = usePromptStore((s) => s.save);
  const removePrompt = usePromptStore((s) => s.remove);

  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [injectedId, setInjectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; open: boolean }>({ msg: '', open: false });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToast({ msg, open: true });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, open: false })), 2000);
  };

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // ESC：编辑器打开时关闭编辑器（主窗口底栏内联模式下使用；独立窗口 PromptLibraryView 由 useEscToCloseWindow 的 onEsc 处理）
  useEscToCloseOverlay(editor.open, () => setEditor(EMPTY_EDITOR));

  const handleInject = async (template: PromptTemplate) => {
    if (!onInject) {
      showToast('暂无可用的注入目标');
      return;
    }
    // 需求 1：传递完整 PromptTemplate，由父组件执行 composeFinalText（含 selection/clipboard 占位符）
    const result = await onInject(template);
    if (result.success) {
      setInjectedId(template.id);
      setTimeout(() => setInjectedId((id) => (id === template.id ? null : id)), 800);
      showToast(result.platformName ? `已注入到 ${result.platformName}` : '已注入');
      // 注入成功后自动收起底栏，方便用户操作
      useTabStore.getState().setBottomBarExpanded(false);
    } else {
      showToast('未找到输入框，请确认页面已加载');
    }
  };

  const openAdd = () => setEditor({ ...EMPTY_EDITOR, open: true });
  const openEdit = (t: PromptTemplate) =>
    setEditor({
      open: true,
      editing: t,
      title: t.title,
      content: t.content ?? '',
      category: t.category ?? '',
      // 需求 2.5：加载局内快捷键
      hotkey: t.hotkey ?? '',
    });

  const handleSave = async () => {
    const title = editor.title.trim();
    const content = editor.content;
    if (!title) {
      showToast('请输入标题');
      return;
    }
    const now = Date.now();
    await savePrompt({
      id: editor.editing?.id ?? '',
      title,
      content,
      category: editor.category.trim() || undefined,
      createdAt: editor.editing?.createdAt ?? now,
      updatedAt: now,
      // 需求 2.5：持久化局内快捷键（空字符串转为 undefined）
      hotkey: editor.hotkey.trim() || undefined,
    });
    setEditor(EMPTY_EDITOR);
    showToast(editor.editing ? '已更新' : '已添加');
  };

  const handleDelete = async () => {
    if (!editor.editing) return;
    await removePrompt(editor.editing.id);
    setEditor(EMPTY_EDITOR);
    showToast('已删除');
  };

  const isModal = open !== undefined;

  const chipList = (
    <div className="prompt-section" data-name="component.prompt-library.section">
      <div className="bottom-section-title" data-name="component.prompt-library.section-title">提示词</div>
      <div className="prompt-chip-row" data-name="component.prompt-library.chip-list">
        {prompts.length === 0 && <span className="prompt-empty" data-name="component.prompt-library.empty">暂无模板，点「+」添加</span>}
        {prompts.map((t, idx) => (
          <span
            key={t.id}
            className={`prompt-chip${injectedId === t.id ? ' injected' : ''}`}
            data-name={`component.prompt-library.chip-${idx + 1}`}
            data-index={idx + 1}
            data-id={t.id}
            onClick={() => void handleInject(t)}
            title={t.content}
          >
            <span className="prompt-chip-title" data-name={`component.prompt-library.chip-title-${idx + 1}`}>{t.title}</span>
            <IconButton
              className="prompt-chip-edit"
              data-name={`component.prompt-library.chip-edit-button-${idx + 1}`}
              aria-label="编辑"
              title="编辑"
              onClick={(e) => {
                e.stopPropagation();
                openEdit(t);
              }}
            >
              <svg
                className="icon-svg-sm"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                data-name={`component.prompt-library.chip-edit-icon-${idx + 1}`}
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </IconButton>
          </span>
        ))}
        <IconButton
          className="prompt-add"
          data-name="component.prompt-library.add-button"
          aria-label="新增提示词"
          title="新增提示词"
          onClick={openAdd}
        >
          <svg
            className="icon-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            data-name="component.prompt-library.add-icon"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
      </div>
    </div>
  );

  return (
    <>
      {isModal ? (
        createPortal(
          <div
            className={`prompt-editor-overlay${open ? ' is-open' : ''}`}
            data-name="component.prompt-library.overlay"
            onClick={onClose}
            aria-hidden={!open}
          >
            <div
              className="prompt-editor"
              role="dialog"
              aria-label="提示词库"
              data-name="component.prompt-library.modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="prompt-editor-header" data-name="component.prompt-library.modal-header">
                <h3 data-name="component.prompt-library.modal-title">提示词库</h3>
                <IconButton
                  variant="close"
                  className="prompt-editor-close"
                  data-name="component.prompt-library.modal-close-button"
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
                    data-name="component.prompt-library.modal-close-icon"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </IconButton>
              </div>
              <div className="prompt-editor-body" data-name="component.prompt-library.modal-body">{chipList}</div>
            </div>
          </div>,
          document.body,
        )
      ) : (
        chipList
      )}

      {/* 编辑器弹窗 —— 通过 portal 渲染到 document.body，
          避免被底栏 .bottom-bar 的 transform 困住导致 position:fixed 失效 */}
      {createPortal(
        <div
          className={`prompt-editor-overlay${editor.open ? ' is-open' : ''}`}
          data-name="component.prompt-library.editor-overlay"
          onClick={() => setEditor(EMPTY_EDITOR)}
          aria-hidden={!editor.open}
        >
        <div
          className="prompt-editor"
          role="dialog"
          aria-label="提示词编辑"
          data-name="component.prompt-library.editor-modal"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="prompt-editor-header" data-name="component.prompt-library.editor-header">
            <h3 data-name="component.prompt-library.editor-title">{editor.editing ? '编辑提示词' : '新增提示词'}</h3>
            <IconButton
              variant="close"
              className="prompt-editor-close"
              data-name="component.prompt-library.editor-close-button"
              aria-label="关闭"
              title="关闭"
              onClick={() => setEditor(EMPTY_EDITOR)}
            >
              <svg
                className="icon-svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                data-name="component.prompt-library.editor-close-icon"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </IconButton>
          </div>
          <PromptEditorForm
            title={editor.title}
            content={editor.content}
            category={editor.category}
            hotkey={editor.hotkey}
            editingId={editor.editing?.id ?? null}
            onTitleChange={(v) => setEditor((s) => ({ ...s, title: v }))}
            onContentChange={(v) => setEditor((s) => ({ ...s, content: v }))}
            onCategoryChange={(v) => setEditor((s) => ({ ...s, category: v }))}
            onHotkeyChange={(v) => setEditor((s) => ({ ...s, hotkey: v }))}
            dataNamePrefix="component.prompt-library.editor"
          />
          <div className="prompt-editor-footer" data-name="component.prompt-library.editor-footer">
            {editor.editing ? (
              <Button
                variant="text"
                danger
                className="prompt-btn"
                data-name="component.prompt-library.delete-button"
                onClick={handleDelete}
              >
                删除
              </Button>
            ) : (
              <span data-name="component.prompt-library.footer-spacer" />
            )}
            <div className="prompt-editor-actions" data-name="component.prompt-library.editor-actions">
              <Button
                variant="outline"
                className="prompt-btn"
                data-name="component.prompt-library.cancel-button"
                onClick={() => setEditor(EMPTY_EDITOR)}
              >
                取消
              </Button>
              <Button
                variant="primary-compact"
                className="prompt-btn"
                data-name="component.prompt-library.save-button"
                onClick={() => void handleSave()}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      </div>,
      document.body,
      )}

      {/* toast */}
      <div
        className={`prompt-toast${toast.open ? ' is-open' : ''}`}
        data-name="component.prompt-library.toast"
      >
        {toast.msg}
      </div>
    </>
  );
}
