/* =====================================================================
   pages/NotesView.tsx —— 灵感笔记（需求 11，嵌入模式）
   架构（v0.5.2 重构）：
   - 不再是独立窗口，作为 StandaloneView 的视图模式之一嵌入渲染
   - 父组件传入 onClose 回调（切回 webview 模式）
   - 主体：textarea 编辑当前激活笔记
   - 底栏：发送到 AI 输入框 / 存为提示词 / 新建 / 历史
   - 数据：通过 notes IPC 直接读写主进程持久化存储
   特性：
   - 实时保存（debounce 500ms）
   - 切换到 webview 再切回，内容保留（state 不卸载）
   - "发送到 AI"：复用 VOICE_INJECT_AND_SEND 通道，主进程查找 lastFocusedWin 注入
   ===================================================================== */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listNotes,
  saveNote,
  deleteNote,
  getActiveNote,
  setActiveNote,
  sendNoteToAi,
  saveNoteAsPrompt,
  onNoteInjectResult,
  getAppSettings,
} from '../lib/electron-api';
import type { Note } from '../lib/electron-api';
import { IconButton } from '../components/ui';
import { useToast } from '../hooks/useToast';
import './NotesView.css';

interface NotesViewProps {
  /** 关闭笔记视图（切回 webview 模式） */
  onClose?: () => void;
}

export default function NotesView({ onClose }: NotesViewProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNoteState] = useState<Note | null>(null);
  const [draft, setDraft] = useState('');
  const [enterToSend, setEnterToSend] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const draftRef = useRef(draft);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast, showToast } = useToast();

  // 初始化：加载笔记列表 + 激活笔记 + enterToSend 设置
  useEffect(() => {
    void (async () => {
      try {
        const [list, active, settings] = await Promise.all([
          listNotes(),
          getActiveNote(),
          getAppSettings(),
        ]);
        setNotes(list);
        setActiveNoteState(active);
        setDraft(active?.content ?? '');
        setEnterToSend(settings.enterToSend ?? true);
      } catch (e) {
        console.error('[NotesView] 初始化失败:', e);
      }
    })();
  }, []);

  // 同步 draft 到 ref（供防抖保存读取最新值）
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // 防抖保存：draft 变化 500ms 后保存
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const currentActive = activeNote;
    // 内容未变化跳过
    if (currentActive && draft === currentActive.content) return;
    saveTimerRef.current = setTimeout(async () => {
      const text = draftRef.current;
      if (!text.trim() && !currentActive) return; // 空内容且无激活笔记，不创建
      try {
        const saved = await saveNote({
          id: currentActive?.id,
          content: text,
        });
        setActiveNoteState(saved);
        // 同步列表中对应项
        setNotes((prev) => {
          const idx = prev.findIndex((n) => n.id === saved.id);
          if (idx === -1) return [saved, ...prev];
          const next = [...prev];
          next[idx] = saved;
          return next.sort((a, b) => b.updatedAt - a.updatedAt);
        });
      } catch (e) {
        console.error('[NotesView] 自动保存失败:', e);
      }
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draft, activeNote]);

  // 监听注入结果回传（主进程 → 笔记窗口）
  useEffect(() => {
    const off = onNoteInjectResult((result) => {
      if (result.success) {
        showToast('已发送到 AI 输入框');
      } else {
        showToast('未找到可注入的窗口，请先打开 AI 对话');
      }
    });
    return off;
  }, [showToast]);

  // 新建笔记：清空 draft + 取消激活
  const handleNew = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await setActiveNote(null);
    } catch { /* ignore */ }
    setActiveNoteState(null);
    setDraft('');
    setShowHistory(false);
    // 聚焦输入框
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.notes-textarea');
      textarea?.focus();
    });
  };

  // 选择历史笔记
  const handleSelectNote = async (note: Note) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await setActiveNote(note.id);
    } catch { /* ignore */ }
    setActiveNoteState(note);
    setDraft(note.content);
    setShowHistory(false);
  };

  // 删除当前笔记（修复 11-7：删除后自动新建空白笔记，避免"删除后无法操作"）
  const handleDelete = async () => {
    if (!activeNote) return;
    if (!confirm('确定删除当前笔记？')) return;
    try {
      await deleteNote(activeNote.id);
      setNotes((prev) => prev.filter((n) => n.id !== activeNote.id));
      // 切换到下一笔记或自动新建空白
      const next = notes.find((n) => n.id !== activeNote.id) ?? null;
      if (next) {
        await setActiveNote(next.id);
        setActiveNoteState(next);
        setDraft(next.content);
      } else {
        // 没有其他笔记了，自动新建空白（避免删除后无法操作）
        await setActiveNote(null);
        setActiveNoteState(null);
        setDraft('');
        requestAnimationFrame(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.notes-textarea');
          textarea?.focus();
        });
      }
      showToast('已删除');
    } catch (e) {
      console.error('[NotesView] 删除失败:', e);
      showToast('删除失败');
    }
  };

  // 发送到 AI 输入框
  const handleSendToAi = async () => {
    const text = draft.trim();
    if (!text) {
      showToast('笔记内容为空');
      return;
    }
    try {
      const result = await sendNoteToAi(text, enterToSend);
      if (!result.ok && result.error) {
        showToast(result.error);
      }
      // 成功结果由 onNoteInjectResult 监听器显示
    } catch (e) {
      console.error('[NotesView] 发送到 AI 失败:', e);
      showToast('发送失败');
    }
  };

  // 存为提示词
  const handleSaveAsPrompt = async () => {
    const text = draft.trim();
    if (!text) {
      showToast('笔记内容为空');
      return;
    }
    try {
      const result = await saveNoteAsPrompt(text);
      if (result.ok) {
        showToast(`已存为提示词：${result.title ?? ''}`);
      } else {
        showToast(result.error ?? '保存失败');
      }
    } catch (e) {
      console.error('[NotesView] 存为提示词失败:', e);
      showToast('保存失败');
    }
  };

  // ESC：历史面板打开时关闭历史；否则触发 onClose 切回 webview
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (showHistory) {
        setShowHistory(false);
      } else {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showHistory, onClose]);

  // 字数统计
  const charCount = useMemo(() => draft.length, [draft]);

  return (
    <div className="notes-view" data-name="notes.container">
      {/* 顶栏 */}
      <header className="notes-top" data-name="notes.topbar">
        <div className="notes-top-title" data-name="notes.topbar-title">灵感笔记</div>
        <div className="notes-top-actions" data-name="notes.topbar-actions">
          <IconButton
            type="button"
            aria-label="历史笔记"
            title="历史笔记"
            variant={showHistory ? 'active' : 'default'}
            className="notes-icon-btn"
            data-name="notes.topbar-history-button"
            onClick={() => setShowHistory((v) => !v)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="notes.topbar-history-icon">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
          </IconButton>
          <IconButton
            type="button"
            aria-label="新建笔记"
            title="新建笔记"
            className="notes-icon-btn"
            data-name="notes.topbar-new-button"
            onClick={handleNew}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="notes.topbar-new-icon">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </IconButton>
          <IconButton
            type="button"
            aria-label="删除笔记"
            title="删除笔记"
            className="notes-icon-btn"
            disabled={!activeNote}
            data-name="notes.topbar-delete-button"
            onClick={handleDelete}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="notes.topbar-delete-icon">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </IconButton>
          {onClose && (
            <IconButton
              type="button"
              aria-label="关闭笔记"
              title="关闭笔记（切回 AI 应用）"
              className="notes-icon-btn"
              data-name="notes.topbar-close-button"
              onClick={onClose}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="notes.topbar-close-icon">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </IconButton>
          )}
        </div>
      </header>

      {/* 主体：编辑器 */}
      <main className="notes-body" data-name="notes.body">
        <textarea
          className="notes-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="随时记下灵感…&#10;支持 {{time}} {{tag}} 占位符（发送到 AI 时自动替换）"
          spellCheck={false}
          autoFocus
          data-name="notes.textarea"
        />
      </main>

      {/* 底栏：字数 + 操作 */}
      <footer className="notes-bottom" data-name="notes.bottombar">
        <span className="notes-char-count" data-name="notes.char-count">{charCount} 字</span>
        <div className="notes-bottom-actions" data-name="notes.bottombar-actions">
          <button
            type="button"
            className="notes-action-btn notes-action-btn-secondary"
            data-name="notes.save-as-prompt-button"
            onClick={handleSaveAsPrompt}
            disabled={!draft.trim()}
          >
            存为提示词
          </button>
          <button
            type="button"
            className="notes-action-btn notes-action-btn-primary"
            data-name="notes.send-to-ai-button"
            onClick={handleSendToAi}
            disabled={!draft.trim()}
          >
            发送到 AI 输入框
          </button>
        </div>
      </footer>

      {/* 历史笔记浮层（修复 11-7：从底部弹出，避免遮挡） */}
      {showHistory && (
        <div className="notes-history-overlay" data-name="notes.history-overlay">
          <div className="notes-history-panel" data-name="notes.history-panel">
            <div className="notes-history-header" data-name="notes.history-header">
              <span data-name="notes.history-title">历史笔记</span>
              <button
                type="button"
                className="notes-history-close"
                aria-label="关闭"
                data-name="notes.history-close-button"
                onClick={() => setShowHistory(false)}
              >
                ×
              </button>
            </div>
            <div className="notes-history-list" data-name="notes.history-list">
              {notes.length === 0 ? (
                <div className="notes-history-empty" data-name="notes.history-empty">暂无笔记</div>
              ) : (
                notes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`notes-history-item ${activeNote?.id === n.id ? 'active' : ''}`}
                    data-name="notes.history-item"
                    onClick={() => void handleSelectNote(n)}
                  >
                    <div className="notes-history-item-title" data-name="notes.history-item-title">
                      {n.content.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 30) || '未命名笔记'}
                    </div>
                    <div className="notes-history-item-meta" data-name="notes.history-item-meta">
                      {new Date(n.updatedAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {' · '}
                      {n.content.length} 字
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="notes-toast" data-name="notes.toast">
          {toast}
        </div>
      )}
    </div>
  );
}
