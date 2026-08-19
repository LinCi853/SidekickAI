/* =====================================================================
   pages/PromptLibraryView.tsx —— 提示词库独立窗口
   架构：
   - 顶栏：标题 + 最小化/最大化/关闭（无边框窗口自定义标题栏）
   - 主体：分类分组卡片列表 + 新增/编辑/删除
   - 注入：点击提示词 → requestPromptInject IPC → 主窗口注入激活 webview → onPromptInjectResult 回传
   - 数据：复用 usePromptStore（与主窗口共享提示词模板）
   ===================================================================== */

import { useEffect, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { usePromptStore } from '../store/usePromptStore';
import {
  requestPromptInject,
  onPromptInjectResult,
  exportPrompts,
  importPrompts,
} from '../lib/electron-api';
import type { PromptTemplate } from '../lib/electron-api';
import { useToast } from '../hooks/useToast';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { Button, IconButton, EmptyState } from '../components/ui';
import PromptEditorForm from '../components/PromptEditorForm';
import './PromptLibraryView.css';

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

export default function PromptLibraryView() {
  const prompts = usePromptStore((s) => s.prompts);
  const init = usePromptStore((s) => s.init);
  const savePrompt = usePromptStore((s) => s.save);
  const removePrompt = usePromptStore((s) => s.remove);

  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [injectedId, setInjectedId] = useState<string | null>(null);
  const { toast, showToast } = useToast();

  // 初始化：加载提示词列表
  useEffect(() => {
    void init().catch((e) => console.error('[PromptLibraryView] 加载提示词失败:', e));
  }, [init]);

  // ESC：编辑器打开时关闭编辑器，否则关闭窗口
  useEscToCloseWindow({
    onEsc: (e) => {
      if (editor.open) {
        e.preventDefault();
        setEditor(EMPTY_EDITOR);
        return true;
      }
      return false;
    },
  });

  // 监听注入结果回传（主进程 → 提示词库窗口）
  useEffect(() => {
    const off = onPromptInjectResult((result) => {
      if (result.success) {
        showToast(result.platformName ? `已注入到 ${result.platformName}` : '已注入');
      } else {
        showToast('未找到输入框，请确认主窗口页面已加载');
      }
    });
    return () => {
      off();
    };
  }, []);

  const handleInject = async (template: PromptTemplate) => {
    setInjectedId(template.id);
    setTimeout(() => setInjectedId((id) => (id === template.id ? null : id)), 800);
    try {
      // 需求 1：请求主窗口注入完整模板，由主窗口执行 composeFinalText 后注入
      await requestPromptInject(template);
    } catch (e) {
      console.error('[PromptLibraryView] 注入请求失败:', e);
      showToast('注入请求失败');
    }
  };

  const openAdd = () => setEditor({ ...EMPTY_EDITOR, open: true });
  const openEdit = (t: PromptTemplate) => {
    setEditor({
      open: true,
      editing: t,
      title: t.title,
      content: t.content ?? '',
      category: t.category ?? '',
      // 需求 2.5：加载局内快捷键
      hotkey: t.hotkey ?? '',
    });
  };

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

  const handleExport = async () => {
    try {
      const result = await exportPrompts();
      if (result.ok) {
        showToast('已导出');
      } else if (!result.canceled) {
        showToast('导出失败');
      }
    } catch (e) {
      console.error('[PromptLibraryView] 导出失败:', e);
      showToast('导出失败');
    }
  };

  const handleImport = async () => {
    try {
      const result = await importPrompts();
      if (result.ok) {
        await init();
        showToast(`已导入：新增 ${result.added ?? 0} 条，更新 ${result.updated ?? 0} 条`);
      } else if (!result.canceled) {
        showToast('导入失败');
      }
    } catch (e) {
      console.error('[PromptLibraryView] 导入失败:', e);
      showToast('导入失败');
    }
  };

  // 按分类分组（无分类归入「未分类」）
  const grouped = prompts.reduce<Record<string, PromptTemplate[]>>((acc, p) => {
    const key = p.category || '未分类';
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});
  const groupKeys = Object.keys(grouped).sort();

  return (
    <>
      <WindowResizeHandles />
      <div className="prompt-view app-shell app-view-root" data-name="prompts.container">
        {/* 顶栏：统一 StandaloneWindowHeader（标题 + 置顶 + 窗口控制） */}
        <StandaloneWindowHeader title="提示词库" dataNamePrefix="prompts.topbar" />

        {/* 主体 */}
        <div className="prompt-view-body" data-name="prompts.body">
          <div className="prompt-view-add-row" data-name="prompts.add-row">
            <Button type="button" variant="outline" className="prompt-view-add-btn" onClick={() => void handleImport()} data-name="prompts.import-button">
              导入
            </Button>
            <Button type="button" variant="outline" className="prompt-view-add-btn" onClick={() => void handleExport()} data-name="prompts.export-button">
              导出
            </Button>
            <Button type="button" variant="outline" className="prompt-view-add-btn" onClick={openAdd} data-name="prompts.add-button">
              + 新增提示词
            </Button>
          </div>

          {prompts.length === 0 && (
            <EmptyState message={<>暂无提示词模板<br />点击「新增提示词」添加</>} size="large" className="prompt-view-empty" data-name="prompts.empty-state" />
          )}

          {groupKeys.map((key, gIdx) => (
            <div key={key} className="prompt-group" data-name={`prompts.group-item-${gIdx + 1}`} data-index={gIdx + 1} data-id={key}>
              <div className="prompt-group-title" data-name={`prompts.group-item-${gIdx + 1}-title`}>{key} ({grouped[key].length})</div>
              {grouped[key].map((t, cIdx) => (
                <div
                  key={t.id}
                  className={`glass-card interactive prompt-card${injectedId === t.id ? ' injected' : ''}`}
                  data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}`}
                  data-index={cIdx + 1}
                  data-id={t.id}
                  onClick={() => void handleInject(t)}
                  title="点击注入到主窗口激活的 AI 输入框"
                >
                  <div className="prompt-card-head" data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-head`}>
                    <span className="prompt-card-title" data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-title`}>{t.title}</span>
                    <div className="prompt-card-actions" data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-actions`}>
                      <IconButton
                        type="button"
                        className="prompt-card-edit-btn"
                        aria-label="编辑"
                        title="编辑"
                        data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-edit-button`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(t);
                        }}
                      >
                        <svg className="icon-svg-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-edit-icon`}>
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </IconButton>
                    </div>
                  </div>
                  <div className="prompt-card-content" data-name={`prompts.group-item-${gIdx + 1}-card-item-${cIdx + 1}-content`}>{t.content}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 编辑器弹窗 */}
      <div
        className={`prompt-editor-overlay${editor.open ? ' is-open' : ''}`}
        data-name="prompts.editor-overlay"
        onClick={() => setEditor(EMPTY_EDITOR)}
        aria-hidden={!editor.open}
      >
        <div className="prompt-editor" role="dialog" aria-label="提示词编辑" data-name="prompts.editor-modal" onClick={(e) => e.stopPropagation()}>
          <div className="prompt-editor-header" data-name="prompts.editor-modal-header">
            <h3 data-name="prompts.editor-title">{editor.editing ? '编辑提示词' : '新增提示词'}</h3>
            <IconButton
              type="button"
              variant="close"
              className="prompt-editor-close"
              aria-label="关闭"
              title="关闭"
              data-name="prompts.editor-close-button"
              onClick={() => setEditor(EMPTY_EDITOR)}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="prompts.editor-close-icon">
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
            dataNamePrefix="prompts.editor"
          />
          <div className="prompt-editor-footer" data-name="prompts.editor-footer">
            {editor.editing ? (
              <Button type="button" variant="danger" className="prompt-btn danger" onClick={handleDelete} data-name="prompts.editor-delete-button">
                删除
              </Button>
            ) : (
              <span data-name="prompts.editor-footer-spacer" />
            )}
            <div className="prompt-editor-actions" data-name="prompts.editor-actions">
              <Button type="button" variant="outline" className="prompt-btn" onClick={() => setEditor(EMPTY_EDITOR)} data-name="prompts.editor-cancel-button">
                取消
              </Button>
              <Button type="button" variant="primary-compact" className="prompt-btn primary" onClick={() => void handleSave()} data-name="prompts.editor-save-button">
                保存
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* toast */}
      <div className={`prompt-toast app-toast${toast !== null ? ' is-open' : ''}`} data-name="prompts.toast">{toast ?? ''}</div>
    </>
  );
}
