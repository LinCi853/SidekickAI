/* =====================================================================
   pages/PromptLibraryView.tsx —— 提示词库独立窗口
   架构：
   - 顶栏：标题 + 最小化/最大化/关闭（无边框窗口自定义标题栏）
   - 主体：分类分组卡片列表 + 新增/编辑/删除
   - 注入：点击提示词 → requestPromptInject IPC → 主窗口注入激活 webview → onPromptInjectResult 回传
   - 数据：复用 usePromptStore（与主窗口共享提示词模板）
   ===================================================================== */

import { useEffect, useMemo, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { usePromptStore } from '../store/usePromptStore';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onMaximizeToggled,
  onPinToggled,
  requestPromptInject,
  onPromptInjectResult,
  getHotkeys,
  startHotkeyRecording,
  stopHotkeyRecording,
  onHotkeyRecordingResult,
} from '../lib/electron-api';
import type { PromptTemplate, HotkeyConfig } from '../lib/electron-api';
import { buildOtherHotkeysForPrompt } from '../lib/prompt-hotkey';
import { useToast } from '../hooks/useToast';
import { Button, IconButton } from '../components/ui';
import Chip from '../components/ui/Chip';
import HotkeyRecorder from '../components/ui/HotkeyRecorder';
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

  const [maximized, setMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [injectedId, setInjectedId] = useState<string | null>(null);
  // 需求 2.5：主进程全局热键列表，用于 HotkeyRecorder 冲突检测
  const [appHotkeys, setAppHotkeys] = useState<HotkeyConfig[]>([]);
  const { toast, showToast } = useToast();

  // 初始化：加载提示词列表 + 最大化状态
  useEffect(() => {
    void init().catch((e) => console.error('[PromptLibraryView] 加载提示词失败:', e));
    void isWindowMaximized().then(setMaximized).catch(() => {});
  }, [init]);

  // 需求 2.5：编辑器打开时拉取最新全局热键，用于冲突检测
  useEffect(() => {
    if (!editor.open) return;
    getHotkeys()
      .then(setAppHotkeys)
      .catch((e) => console.warn('[PromptLibraryView] 加载全局热键失败:', e));
  }, [editor.open]);

  // F11/F12 由主进程 attachWindowHotkeyInterceptor 拦截处理，渲染层仅通过 IPC 监听状态更新
  useEffect(() => {
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);
  useEffect(() => {
    const offPin = onPinToggled((onTop) => setIsPinned(onTop));
    const offMax = onMaximizeToggled((max) => setMaximized(max));
    return () => { offPin(); offMax(); };
  }, []);

  // ESC：编辑器打开时关闭编辑器，否则关闭窗口
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 输入框聚焦时不触发（让 input/textarea 自身处理）
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (editor.open) {
        e.preventDefault();
        setEditor(EMPTY_EDITOR);
      } else {
        e.preventDefault();
        void closeCurrentWindow();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editor.open]);

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

  const handleMaximize = async () => {
    const next = await maximizeToggleWindow();
    setMaximized(next);
  };

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    prompts.forEach((p) => { if (p.category) set.add(p.category) });
    return Array.from(set);
  }, [prompts]);

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
      <div className="prompt-view app-shell" data-name="prompts.container">
        {/* 顶栏 */}
        <div className="prompt-view-top" data-name="prompts.topbar">
          <div className="prompt-view-top-drag" data-name="prompts.topbar-drag">
            <span className="prompt-view-top-title" data-name="prompts.topbar-title">提示词库</span>
          </div>
          <div className="prompt-view-top-actions" data-name="prompts.topbar-actions">
            <IconButton
              type="button"
              variant={isPinned ? 'active' : 'default'}
              className="prompt-view-win-btn"
              aria-label={isPinned ? '取消置顶' : '置顶'}
              title={isPinned ? '取消置顶' : '置顶'}
              data-name="prompts.topbar-pin-button"
              onClick={async () => {
                const next = !isPinned;
                setIsPinned(next);
                await pinCurrentWindow(next);
              }}
            >
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="prompts.topbar-pin-icon">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
            <IconButton type="button" className="prompt-view-win-btn" onClick={() => void minimizeWindow()} title="最小化" aria-label="最小化" data-name="prompts.topbar-minimize-button">
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="prompts.topbar-minimize-icon"><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </IconButton>
            <IconButton type="button" className="prompt-view-win-btn" onClick={() => void handleMaximize()} title={maximized ? '还原' : '最大化'} aria-label="最大化" data-name="prompts.topbar-maximize-button">
              {maximized ? (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="prompts.topbar-restore-icon"><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
              ) : (
                <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="prompts.topbar-maximize-icon"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
              )}
            </IconButton>
            <IconButton type="button" variant="close" className="prompt-view-win-btn close" onClick={() => void closeCurrentWindow()} title="关闭" aria-label="关闭" data-name="prompts.topbar-close-button">
              <svg className="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="prompts.topbar-close-icon"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </IconButton>
          </div>
        </div>

        {/* 主体 */}
        <div className="prompt-view-body" data-name="prompts.body">
          <div className="prompt-view-add-row" data-name="prompts.add-row">
            <Button type="button" variant="ghost" className="prompt-view-add-btn" onClick={openAdd} data-name="prompts.add-button">
              + 新增提示词
            </Button>
          </div>

          {prompts.length === 0 && (
            <div className="prompt-view-empty" data-name="prompts.empty-state">暂无提示词模板<br />点击「新增提示词」添加</div>
          )}

          {groupKeys.map((key, gIdx) => (
            <div key={key} className="prompt-group" data-name={`prompts.group-item-${gIdx + 1}`} data-index={gIdx + 1} data-id={key}>
              <div className="prompt-group-title" data-name={`prompts.group-item-${gIdx + 1}-title`}>{key} ({grouped[key].length})</div>
              {grouped[key].map((t, cIdx) => (
                <div
                  key={t.id}
                  className={`prompt-card${injectedId === t.id ? ' injected' : ''}`}
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
          <div className="prompt-editor-body" data-name="prompts.editor-modal-body">
            <div className="prompt-field" data-name="prompts.editor-field-title">
              <label data-name="prompts.editor-title-label">标题</label>
              <input
                value={editor.title}
                autoFocus
                spellCheck={false}
                placeholder="如：总结全文"
                data-name="prompts.editor-title-input"
                onChange={(e) => setEditor((s) => ({ ...s, title: e.target.value }))}
              />
            </div>
            <div className="prompt-field" data-name="prompts.editor-field-category">
              <label data-name="prompts.editor-category-label">分类（可选）</label>
              <div className="prompt-category-chips">
                {allCategories.map((cat) => (
                  <Chip key={cat} selected={editor.category === cat}
                    onClick={() => setEditor((s) => ({ ...s, category: s.category === cat ? '' : cat }))}
                    data-name="prompts.editor-category-chip">
                    {cat}
                  </Chip>
                ))}
                <input
                  value={editor.category}
                  spellCheck={false}
                  placeholder="新增分类..."
                  data-name="prompts.editor-category-input"
                  onChange={(e) => setEditor((s) => ({ ...s, category: e.target.value }))}
                />
              </div>
            </div>
            {/* 单 textarea + {{body}} 占位符 */}
            <div className="prompt-field" data-name="prompts.editor-field-content">
              <label data-name="prompts.editor-content-label">内容</label>
              <textarea
                value={editor.content}
                spellCheck={false}
                placeholder="输入提示词内容，使用 {{body}} 作为当前输入框内容的占位符（点击上方提示可复制）"
                data-name="prompts.editor-content-textarea"
                onChange={(e) => setEditor((s) => ({ ...s, content: e.target.value }))}
              />
            </div>
            <div className="prompt-field-hint" data-name="prompts.editor-placeholder-hint">
              占位符：
              <code
                style={{ cursor: 'pointer', userSelect: 'all' }}
                onClick={() => navigator.clipboard.writeText('{{body}}')}
                title="点击复制"
                data-name="prompts.editor-placeholder-copy"
              >{'{{body}}'}</code>
              当前输入框内容（点击复制）
            </div>
            {/* 需求 2.5：局内快捷键录入 */}
            <div className="prompt-field" data-name="prompts.editor-field-hotkey">
              <label data-name="prompts.editor-hotkey-label">局内快捷键（可选）</label>
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
              <div className="prompt-field-hint" data-name="prompts.editor-hotkey-hint">
                在主窗口聚焦时按下快捷键即注入该模板；与全局热键冲突的将自动跳过
              </div>
            </div>
          </div>
          <div className="prompt-editor-footer" data-name="prompts.editor-footer">
            {editor.editing ? (
              <Button type="button" variant="danger" className="prompt-btn danger" onClick={handleDelete} data-name="prompts.editor-delete-button">
                删除
              </Button>
            ) : (
              <span data-name="prompts.editor-footer-spacer" />
            )}
            <div className="prompt-editor-actions" data-name="prompts.editor-actions">
              <Button type="button" variant="text" className="prompt-btn" onClick={() => setEditor(EMPTY_EDITOR)} data-name="prompts.editor-cancel-button">
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
      <div className={`prompt-toast${toast !== null ? ' is-open' : ''}`} data-name="prompts.toast">{toast ?? ''}</div>
    </>
  );
}
