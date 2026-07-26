/* =====================================================================
   pages/NotesView.tsx —— 灵感笔记（v2：TipTap 富文本 + 搜索 + 分类 + flushDraft）
   架构：
   - 容器组件 NotesView：状态 + 数据加载 + 搜索/筛选 + flushDraft
   - 展示子组件 NotesSidebar：搜索框 + 标签筛选 + 笔记列表（置顶/普通）
   - 展示子组件 NotesEditor：TipTap 编辑器 + 标题 + 标签 + 置顶 + 工具栏
   数据丢失修复（核心）：
   - 切换笔记 / 组件卸载 / beforeunload 前 flushDraft
   - flushDraft 将 draftRef 中的草稿同步保存到 SQLite
   ===================================================================== */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import {
  listNotes,
  saveNote,
  saveNoteSync,
  deleteNote,
  getActiveNote,
  setActiveNote,
  setNotePinned,
  setNoteTags,
  listNoteTags,
  sendNoteToAi,
  saveNoteAsPrompt,
  onNoteInjectResult,
} from '../lib/electron-api';
import type { Note, NoteSaveInput } from '../lib/electron-api';
import { IconButton } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { useAutoSaveDraft } from '../hooks/useAutoSaveDraft';
import './NotesView.css';

// lowlight 实例：使用 common 语言集合（CodeBlockLowlight 必需）
const lowlight = createLowlight(common);

/** 草稿状态（实时跟踪编辑器内容，供 flushDraft 读取） */
interface DraftState {
  id: string | null;
  title: string | null;
  content: string;
  contentJson: string;
}

// ============================================================================
// 展示子组件：NotesSidebar
// ============================================================================

interface NotesSidebarProps {
  notes: Note[];
  activeId: string | null;
  allTags: string[];
  searchKeyword: string;
  filterTag: string | undefined;
  onSearchChange: (keyword: string) => void;
  onTagFilter: (tag: string | undefined) => void;
  onSelect: (note: Note) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

function NotesSidebar({
  notes,
  activeId,
  allTags,
  searchKeyword,
  filterTag,
  onSearchChange,
  onTagFilter,
  onSelect,
  onCreate,
  onDelete,
}: NotesSidebarProps) {
  const pinnedNotes = notes.filter((n) => n.pinned);
  const normalNotes = notes.filter((n) => !n.pinned);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const renderNoteItem = (note: Note, idx: number) => (
    <div
      key={note.id}
      className={`notes-sidebar-item ${note.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(note)}
      data-name={`advanced-panel.notes-sidebar-item-${idx + 1}`}
      data-index={idx + 1}
      data-id={note.id}
      data-pinned={note.pinned ? 'true' : 'false'}
    >
      <div className="notes-sidebar-item-main" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-main`}>
        <div className="notes-sidebar-item-title" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-title`}>
          {note.pinned && <span className="notes-pin-icon">★</span>}
          {note.title || note.content.split('\n').find((l) => l.trim())?.slice(0, 30) || '空白笔记'}
        </div>
        <div className="notes-sidebar-item-meta" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-meta`}>
          <span className="notes-sidebar-item-time" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-time`}>{formatTime(note.updatedAt)}</span>
          {note.tags.length > 0 && (
            <span className="notes-sidebar-item-tags" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-tags`}>
              {note.tags.map((t) => (
                <span key={t} className="notes-tag-chip" data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-tag-${t}`}>{t}</span>
              ))}
            </span>
          )}
        </div>
      </div>
      <button
        className="notes-sidebar-item-delete sidebar-list-item-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(note.id); }}
        title="删除"
        aria-label="删除笔记"
        data-name={`advanced-panel.notes-sidebar-item-${idx + 1}-delete-button`}
      >
        ×
      </button>
    </div>
  );

  return (
    <div className="notes-sidebar app-sidebar-narrow" data-name="advanced-panel.notes-sidebar">
      <div className="notes-sidebar-search" data-name="advanced-panel.notes-sidebar-search">
        <input
          type="text"
          className="notes-search-input"
          placeholder="搜索笔记…"
          value={searchKeyword}
          onChange={(e) => onSearchChange(e.target.value)}
          data-name="advanced-panel.notes-sidebar-search-input"
        />
        <IconButton variant="default" aria-label="新建笔记" onClick={onCreate} title="新建笔记" data-name="advanced-panel.notes-sidebar-create-button">
          +
        </IconButton>
      </div>
      {allTags.length > 0 && (
        <div className="notes-sidebar-tags" data-name="advanced-panel.notes-sidebar-tags">
          <button
            className={`notes-tag-filter ${!filterTag ? 'active' : ''}`}
            onClick={() => onTagFilter(undefined)}
            data-name="advanced-panel.notes-sidebar-tag-filter-all"
          >
            全部
          </button>
          {allTags.map((tag, idx) => (
            <button
              key={tag}
              className={`notes-tag-filter ${filterTag === tag ? 'active' : ''}`}
              onClick={() => onTagFilter(filterTag === tag ? undefined : tag)}
              data-name={`advanced-panel.notes-sidebar-tag-filter-${idx + 1}`}
              data-tag={tag}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <div className="notes-sidebar-list" data-name="advanced-panel.notes-sidebar-list">
        {notes.length === 0 && (
          <div className="notes-sidebar-empty app-empty-state" data-name="advanced-panel.notes-sidebar-empty">
            {searchKeyword || filterTag ? '无匹配笔记' : '点击 + 新建笔记'}
          </div>
        )}
        {pinnedNotes.length > 0 && (
          <>
            <div className="notes-sidebar-section" data-name="advanced-panel.notes-sidebar-section-pinned">置顶</div>
            {pinnedNotes.map((n, i) => renderNoteItem(n, i))}
          </>
        )}
        {normalNotes.length > 0 && (
          <>
            {pinnedNotes.length > 0 && <div className="notes-sidebar-section" data-name="advanced-panel.notes-sidebar-section-all">全部</div>}
            {normalNotes.map((n, i) => renderNoteItem(n, pinnedNotes.length + i))}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// 展示子组件：NotesEditor
// ============================================================================

interface NotesEditorProps {
  note: Note | null;
  onContentChange: (content: string, contentJson: string) => void;
  onTogglePin: () => void;
  onTagsChange: (tags: string[]) => void;
  onSendToAi: () => void;
  onSaveAsPrompt: () => void;
}

function NotesEditor({
  note,
  onContentChange,
  onTogglePin,
  onTagsChange,
  onSendToAi,
  onSaveAsPrompt,
}: NotesEditorProps) {
  const [tagInput, setTagInput] = useState('');
  const editor = useEditor({
    extensions: [
      // 禁用 StarterKit 内置 codeBlock，避免与 CodeBlockLowlight 重复
      StarterKit.configure({ codeBlock: false }),
      Placeholder.configure({ placeholder: '记录你的灵感…' }),
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight }),
    ],
    content: '',
    onUpdate: ({ editor }) => {
      const text = editor.getText();
      const json = JSON.stringify(editor.getJSON());
      onContentChange(text, json);
    },
  });

  // 笔记切换时更新编辑器内容
  useEffect(() => {
    if (!editor) return;
    if (note?.contentJson) {
      try {
        const json = JSON.parse(note.contentJson);
        editor.commands.setContent(json);
      } catch {
        editor.commands.setContent(note.content || '');
      }
    } else {
      editor.commands.clearContent();
    }
  }, [note?.id, editor]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className="notes-editor-empty-text app-empty-state" data-name="advanced-panel.notes-editor-empty-text">选择或新建一条笔记</div>
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
            className={`notes-icon-btn ${note.pinned ? 'active' : ''}`}
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
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="加粗"
          aria-label="加粗"
          data-name="advanced-panel.notes-toolbar-bold-button"
        >
          B
        </button>
        <button
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="斜体"
          aria-label="斜体"
          data-name="advanced-panel.notes-toolbar-italic-button"
        >
          I
        </button>
        <button
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          title="标题"
          aria-label="标题"
          data-name="advanced-panel.notes-toolbar-heading-button"
        >
          H
        </button>
        <button
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title="无序列表"
          aria-label="无序列表"
          data-name="advanced-panel.notes-toolbar-bullet-list-button"
        >
          •
        </button>
        <button
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          title="任务列表"
          aria-label="任务列表"
          data-name="advanced-panel.notes-toolbar-task-list-button"
        >
          ☑
        </button>
        <button
          className="notes-icon-btn"
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          title="代码块"
          aria-label="代码块"
          data-name="advanced-panel.notes-toolbar-code-block-button"
        >
          {'</>'}
        </button>
      </div>

      <div className="notes-editor-body" data-name="advanced-panel.notes-editor-body">
        <EditorContent editor={editor} />
      </div>

      <div className="notes-bottom" data-name="advanced-panel.notes-bottom">
        <span className="notes-char-count" data-name="advanced-panel.notes-char-count">
          {note.content.length} 字
        </span>
        <div className="notes-bottom-actions" data-name="advanced-panel.notes-bottom-actions">
          <button className="btn-outline notes-action-btn notes-action-btn-secondary" onClick={onSaveAsPrompt} data-name="advanced-panel.notes-save-as-prompt-button">
            存为提示词
          </button>
          <button className="notes-action-btn notes-action-btn-primary" onClick={onSendToAi} data-name="advanced-panel.notes-send-to-ai-button">
            发送到 AI
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 容器组件：NotesView
// ============================================================================

interface NotesViewProps {
  onClose?: () => void;
}

export default function NotesView(_: NotesViewProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNoteState] = useState<Note | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [filterTag, setFilterTag] = useState<string | undefined>();
  const [allTags, setAllTags] = useState<string[]>([]);
  const { toast, showToast } = useToast();

  // 草稿引用（实时跟踪编辑器内容，flushDraft 读取）
  const draftRef = useRef<DraftState | null>(null);
  const activeNoteRef = useRef<Note | null>(null);

  activeNoteRef.current = activeNote;

  // ===== 数据加载 =====
  const refreshList = useCallback(async () => {
    const filter: { keyword?: string; tag?: string } = {};
    if (searchKeyword.trim()) filter.keyword = searchKeyword.trim();
    if (filterTag) filter.tag = filterTag;
    const list = await listNotes(Object.keys(filter).length > 0 ? filter : undefined);
    setNotes(list);
    return list;
  }, [searchKeyword, filterTag]);

  const refreshTags = useCallback(async () => {
    try {
      const tags = await listNoteTags();
      setAllTags(tags);
    } catch {
      // 忽略
    }
  }, []);

  // ===== flushDraft（核心修复：切换/卸载前保存草稿） =====
  const flushDraft = useCallback(async () => {
    const draft = draftRef.current;
    if (!draft || !draft.content.trim()) return;
    draftRef.current = null;
    try {
      const input: NoteSaveInput = {
        content: draft.content,
        contentJson: draft.contentJson,
      };
      if (draft.id) input.id = draft.id;
      if (draft.title !== null) input.title = draft.title;
      const saved = await saveNote(input);
      setActiveNoteState((prev) => (prev?.id === saved.id ? saved : prev));
      await refreshList();
      await refreshTags();
    } catch (err) {
      console.error('[NotesView] flushDraft failed:', err);
    }
  }, [refreshList, refreshTags]);

  // ===== 初始化 =====
  useEffect(() => {
    void (async () => {
      try {
        const [list, active] = await Promise.all([listNotes(), getActiveNote()]);
        setNotes(list);
        setActiveNoteState(active);
        if (active) {
          draftRef.current = {
            id: active.id,
            title: active.title,
            content: active.content,
            contentJson: active.contentJson,
          };
        }
        await refreshTags();
      } catch (e) {
        console.error('[NotesView] init failed:', e);
      }
    })();
  }, [refreshTags]);

  // ===== 搜索/筛选变化时重新加载列表 =====
  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // ===== 防抖自动保存 + beforeunload 同步兜底 + 卸载前 flush（统一委托 useAutoSaveDraft） =====
  const { schedule: scheduleSave, flushNow } = useAutoSaveDraft<DraftState | null>({
    data: draftRef.current,
    save: flushDraft,
    saveSync: () => {
      const draft = draftRef.current;
      if (!draft || !draft.content.trim()) return;
      try {
        const input: NoteSaveInput = {
          content: draft.content,
          contentJson: draft.contentJson,
        };
        if (draft.id) input.id = draft.id;
        if (draft.title !== null) input.title = draft.title;
        saveNoteSync(input);
      } catch (err) {
        console.error('[NotesView] sync save failed:', err);
      }
    },
    debounceMs: 800,
  });

  // ===== 监听注入结果回传 =====
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

  // ===== 事件处理 =====

  // 新建笔记
  const handleNew = useCallback(async () => {
    await flushNow();
    try {
      await setActiveNote(null);
    } catch { /* ignore */ }
    // 创建临时空 note（id 为空串表示"新建"，编辑器渲染但尚未入库）
    const emptyNote: Note = {
      id: '',
      title: null,
      content: '',
      contentJson: '',
      pinned: false,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setActiveNoteState(emptyNote);
    draftRef.current = { id: null, title: null, content: '', contentJson: '' };
  }, [flushNow]);

  // 选择笔记
  const handleSelectNote = useCallback(async (note: Note) => {
    await flushNow();
    try {
      await setActiveNote(note.id);
    } catch { /* ignore */ }
    setActiveNoteState(note);
    draftRef.current = {
      id: note.id,
      title: note.title,
      content: note.content,
      contentJson: note.contentJson,
    };
  }, [flushNow]);

  // 删除笔记
  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteNote(id);
      if (activeNoteRef.current?.id === id) {
        setActiveNoteState(null);
        draftRef.current = null;
        await setActiveNote(null);
      }
      await refreshList();
      await refreshTags();
    } catch (err) {
      console.error('[NotesView] delete failed:', err);
      showToast('删除失败');
    }
  }, [refreshList, refreshTags, showToast]);

  // 标题变化（已移除独立标题输入；标题从首行内容推导）

  // 内容变化：首行作为标题（剥离 markdown # 前缀），其余为正文
  const handleContentChange = useCallback((content: string, contentJson: string) => {
    // 使用 || 而非 ??，将空串 id（新建笔记）转为 null
    const id = activeNoteRef.current?.id || null;
    // 首行非空行作为标题，剥离 markdown 标题前缀（# ## ###）
    const firstLine = content.split('\n').find((l) => l.trim()) ?? '';
    const title = firstLine.replace(/^#{1,6}\s*/, '').trim() || null;
    draftRef.current = { id, title, content, contentJson };
    scheduleSave();
  }, [scheduleSave]);

  // 切换置顶
  const handleTogglePin = useCallback(async () => {
    const note = activeNoteRef.current;
    if (!note || !note.id) return; // 未保存的新笔记跳过
    try {
      await setNotePinned(note.id, !note.pinned);
      const updated = { ...note, pinned: !note.pinned };
      setActiveNoteState(updated);
      await refreshList();
    } catch (err) {
      console.error('[NotesView] toggle pin failed:', err);
    }
  }, [refreshList]);

  // 标签变化
  const handleTagsChange = useCallback(async (tags: string[]) => {
    const note = activeNoteRef.current;
    if (!note || !note.id) return; // 未保存的新笔记跳过
    try {
      await setNoteTags(note.id, tags);
      const updated = { ...note, tags };
      setActiveNoteState(updated);
      await refreshList();
      await refreshTags();
    } catch (err) {
      console.error('[NotesView] set tags failed:', err);
    }
  }, [refreshList, refreshTags]);

  // 发送到 AI
  const handleSendToAi = useCallback(async () => {
    const draft = draftRef.current;
    const note = activeNoteRef.current;
    const text = draft?.content ?? note?.content ?? '';
    if (!text.trim()) return;
    try {
      await sendNoteToAi(text, true);
    } catch (err) {
      console.error('[NotesView] send to AI failed:', err);
      showToast('发送失败');
    }
  }, [showToast]);

  // 存为提示词
  const handleSaveAsPrompt = useCallback(async () => {
    const draft = draftRef.current;
    const note = activeNoteRef.current;
    const text = draft?.content ?? note?.content ?? '';
    if (!text.trim()) return;
    try {
      const result = await saveNoteAsPrompt(text, note?.title ?? undefined);
      if (result.ok) {
        showToast('已保存为提示词');
      } else {
        showToast(result.error || '保存失败');
      }
    } catch (err) {
      console.error('[NotesView] save as prompt failed:', err);
      showToast('保存失败');
    }
  }, [showToast]);

  return (
    <div className="notes-view app-view-root" data-name="advanced-panel.notes-view">
      <div className="notes-body" data-name="advanced-panel.notes-body">
        <NotesSidebar
          notes={notes}
          activeId={activeNote?.id || null}
          allTags={allTags}
          searchKeyword={searchKeyword}
          filterTag={filterTag}
          onSearchChange={setSearchKeyword}
          onTagFilter={setFilterTag}
          onSelect={handleSelectNote}
          onCreate={handleNew}
          onDelete={handleDelete}
        />
        <NotesEditor
          note={activeNote}
          onContentChange={handleContentChange}
          onTogglePin={handleTogglePin}
          onTagsChange={handleTagsChange}
          onSendToAi={handleSendToAi}
          onSaveAsPrompt={handleSaveAsPrompt}
        />
      </div>
      {toast && <div className="notes-toast app-toast" data-name="advanced-panel.notes-toast">{toast}</div>}
    </div>
  );
}
