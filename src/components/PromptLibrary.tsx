/* =====================================================================
   components/PromptLibrary.tsx —— 提示词模板库（明输入明注入）
   嵌入底栏展开面板：横向 chip 列表，单击注入到当前激活标签的 AI 输入框；
   「+」新增 / 右键编辑删除。注入由父组件通过 onInject 回调执行。
   ===================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PromptTemplate, HotkeyConfig } from '../lib/electron-api';
import { usePromptStore } from '../store/usePromptStore';
import { useTabStore } from '../store/useTabStore';
import {
  getHotkeys,
  startHotkeyRecording,
  stopHotkeyRecording,
  onHotkeyRecordingResult,
} from '../lib/electron-api';
import { buildOtherHotkeysForPrompt } from '../lib/prompt-hotkey';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Chip from './ui/Chip';
import HotkeyRecorder from './ui/HotkeyRecorder';
import './PromptLibrary.css';

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
  // 需求 2.5：主进程全局热键列表，用于 HotkeyRecorder 冲突检测
  const [appHotkeys, setAppHotkeys] = useState<HotkeyConfig[]>([]);

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

  // 需求 2.5：编辑器打开时拉取最新全局热键，用于冲突检测
  useEffect(() => {
    if (!editor.open) return;
    getHotkeys()
      .then(setAppHotkeys)
      .catch((e) => console.warn('[PromptLibrary] 加载全局热键失败:', e));
  }, [editor.open]);

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

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    prompts.forEach((p) => { if (p.category) set.add(p.category) });
    return Array.from(set);
  }, [prompts]);

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
        <div
          className={`prompt-overlay${open ? ' is-open' : ''}`}
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
        </div>
      ) : (
        chipList
      )}

      {/* 编辑器弹窗 */}
      <div
        className={`prompt-overlay${editor.open ? ' is-open' : ''}`}
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
          <div className="prompt-editor-body" data-name="component.prompt-library.editor-body">
            <div className="prompt-field" data-name="component.prompt-library.title-field">
              <label data-name="component.prompt-library.title-label">标题</label>
              <input
                value={editor.title}
                data-name="component.prompt-library.title-input"
                autoFocus
                spellCheck={false}
                placeholder="如：总结全文"
                onChange={(e) => setEditor((s) => ({ ...s, title: e.target.value }))}
              />
            </div>
            <div className="prompt-field" data-name="component.prompt-library.category-field">
              <label data-name="component.prompt-library.category-label">分类（可选）</label>
              <div className="prompt-category-chips">
                {allCategories.map((cat) => (
                  <Chip key={cat} selected={editor.category === cat}
                    onClick={() => setEditor((s) => ({ ...s, category: s.category === cat ? '' : cat }))}
                    data-name="component.prompt-library.category-chip">
                    {cat}
                  </Chip>
                ))}
                <input
                  value={editor.category}
                  data-name="component.prompt-library.category-input"
                  spellCheck={false}
                  placeholder="新增分类..."
                  onChange={(e) => setEditor((s) => ({ ...s, category: e.target.value }))}
                />
              </div>
            </div>
            <div className="prompt-field" data-name="component.prompt-library.content-field">
              <label data-name="component.prompt-library.content-label">内容</label>
              <textarea
                value={editor.content}
                data-name="component.prompt-library.content-textarea"
                spellCheck={false}
                placeholder="输入提示词内容，使用 {{body}} 作为当前输入框内容的占位符（点击上方提示可复制）"
                onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
              />
            </div>
            <div className="prompt-field-hint" data-name="component.prompt-library.placeholder-hint">
              占位符：
              <code
                style={{ cursor: 'pointer', userSelect: 'all' }}
                onClick={() => navigator.clipboard.writeText('{{body}}')}
                title="点击复制"
                data-name="component.prompt-library.placeholder-copy"
              >{'{{body}}'}</code>
              当前输入框内容（点击复制）
            </div>
            {/* 需求 2.5：局内快捷键录入 */}
            <div className="prompt-field" data-name="component.prompt-library.hotkey-field">
              <label data-name="component.prompt-library.hotkey-label">局内快捷键（可选）</label>
              <HotkeyRecorder
                value={editor.hotkey}
                placeholder="点击录入（如 Ctrl+Shift+1）"
                className="prompt-hotkey-input"
                onRecord={(acc) => setEditor((s) => ({ ...s, hotkey: acc }))}
                otherHotkeys={buildOtherHotkeysForPrompt(
                  appHotkeys,
                  editor.editing?.id ?? null,
                  prompts,
                )}
                startRecording={startHotkeyRecording}
                stopRecording={stopHotkeyRecording}
                onRecordingResult={onHotkeyRecordingResult}
              />
              <div className="prompt-field-hint" data-name="component.prompt-library.hotkey-hint">
                在主窗口聚焦时按下快捷键即注入该模板；与全局热键冲突的将自动跳过
              </div>
            </div>
          </div>
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
                variant="text"
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
      </div>

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
