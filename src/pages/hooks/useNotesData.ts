/* =====================================================================
   pages/hooks/useNotesData.ts —— 灵感笔记数据层 Hook
   从 NotesView 容器抽离的数据加载与管理逻辑：
   - 笔记列表加载 / 新建 / 删除 / 重命名（标题由首行内容推导）
   - 活跃笔记状态管理 + flushDraft 草稿保存
   - 搜索 / 标签筛选 / 置顶 / 标签变更 / 发送到 AI / 存为提示词
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  onNoteInjectResult,
} from '../../lib/electron-api/notes.js';
import { getAppSettings, updateAppSettings } from '../../lib/electron-api/settings.js';
import type { Note, NoteSaveInput } from '../../../electron/shared/types.js';
import { useToast } from '../../hooks/useToast.js';
import { useAutoSaveDraft } from '../../hooks/useAutoSaveDraft.js';

/** 草稿状态（实时跟踪编辑器内容，供 flushDraft 读取） */
interface DraftState {
  id: string | null;
  title: string | null;
  content: string;
  contentJson: string;
}

export interface UseNotesDataResult {
  notes: Note[];
  activeNote: Note | null;
  searchKeyword: string;
  setSearchKeyword: (keyword: string) => void;
  filterTag: string | undefined;
  setFilterTag: (tag: string | undefined) => void;
  allTags: string[];
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  handleSidebarResize: (w: number) => void;
  handleSidebarToggleCollapse: () => void;
  toast: string | null;
  showToast: (msg: string) => void;
  saveAsPromptOpen: boolean;
  saveAsPromptContent: string;
  saveAsPromptTitle: string | undefined;
  setSaveAsPromptOpen: (open: boolean) => void;
  beforeLeave: (commit: () => void) => Promise<void>;
  handleNew: () => Promise<void>;
  handleSelectNote: (note: Note) => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleContentChange: (content: string, contentJson: string) => void;
  handleTogglePin: () => Promise<void>;
  handleTagsChange: (tags: string[]) => Promise<void>;
  handleSendToAi: () => Promise<void>;
  handleSaveAsPrompt: () => void;
}

export function useNotesData(): UseNotesDataResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [activeNote, setActiveNoteState] = useState<Note | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [filterTag, setFilterTag] = useState<string | undefined>();
  const [allTags, setAllTags] = useState<string[]>([]);
  // 侧边栏宽度/收起状态（持久化到 app settings）
  const [sidebarWidth, setSidebarWidth] = useState(160);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { toast, showToast } = useToast();
  // 存为提示词遮罩状态
  const [saveAsPromptOpen, setSaveAsPromptOpen] = useState(false);
  const [saveAsPromptContent, setSaveAsPromptContent] = useState('');
  const [saveAsPromptTitle, setSaveAsPromptTitle] = useState<string | undefined>(undefined);

  // 草稿引用（实时跟踪编辑器内容，flushDraft 读取）
  const draftRef = useRef<DraftState | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const navigationRef = useRef(false);
  const activeNoteRef = useRef<Note | null>(null);
  // 最新内容引用（不被 auto-save 清空，供 handleSaveAsPrompt 读取）
  const latestContentRef = useRef<string>('');

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

  // Reserve an upsert id before the first write so failed or synchronous retries
  // cannot create duplicates, even when a write committed but its reply was lost.
  const prepareDraft = useCallback(() => {
    const draft = draftRef.current;
    if (!draft || (!draft.id && !draft.content.trim())) return null;
    if (!draft.id) draft.id = crypto.randomUUID();
    const input: NoteSaveInput = { ...draft, id: draft.id, title: draft.title ?? undefined };
    return { draft, input };
  }, []);

  const acceptSavedDraft = useCallback((draft: DraftState, saved: Note) => {
    const current = draftRef.current;
    if (current === draft) draftRef.current = null;
    const active = activeNoteRef.current;
    if (!active || (active.id && active.id !== saved.id)) return;
    // A first save can finish after another edit; backfill its id without
    // replacing the editor's newer content when the id change rerenders it.
    const next = current && current !== draft && current.id === saved.id
      ? { ...saved, ...current, id: saved.id }
      : saved;
    activeNoteRef.current = next;
    setActiveNoteState(next);
  }, []);

  // Serialize writes and drain edits made while a save was pending. Only the
  // exact acknowledged snapshot is cleared; failures leave it available to retry.
  const flushDraft = useCallback(async (): Promise<void> => {
    while (true) {
      if (inFlightRef.current) {
        await inFlightRef.current;
        continue;
      }
      const pending = prepareDraft();
      if (!pending) return;
      const { draft, input } = pending;
      const writing = (async () => {
        const saved = await saveNote(input);
        acceptSavedDraft(draft, saved);
      })();
      inFlightRef.current = writing;
      try { await writing; }
      finally { inFlightRef.current = null; }
      // List refresh failure is not a failed durable save.
      void refreshList().catch((error) => console.error('[NotesView] refresh failed:', error));
      void refreshTags();
    }
  }, [prepareDraft, acceptSavedDraft, refreshList, refreshTags]);

  // ===== 初始化 =====
  // StrictMode 防护：开发模式下 useEffect 执行两次，防止重复创建笔记
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (initDoneRef.current) return;
    initDoneRef.current = true;
    void (async () => {
      try {
        const [list, active] = await Promise.all([listNotes(), getActiveNote()]);
        setNotes(list);
        if (active) {
          setActiveNoteState(active);
          draftRef.current = {
            id: active.id,
            title: active.title,
            content: active.content,
            contentJson: active.contentJson,
          };
          latestContentRef.current = active.content;
        } else if (list.length === 0) {
          // 无笔记时自动创建一个空白笔记
          const saved = await saveNote({});
          const updated = await listNotes();
          setNotes(updated);
          if (saved?.id) {
            await setActiveNote(saved.id);
            setActiveNoteState(saved);
            draftRef.current = { id: saved.id, title: null, content: '', contentJson: '' };
            latestContentRef.current = '';
          }
        } else {
          // 有笔记但无活跃笔记，选中最新的
          const sorted = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          const newest = sorted[0];
          await setActiveNote(newest.id);
          setActiveNoteState(newest);
          draftRef.current = { id: newest.id, title: newest.title, content: newest.content, contentJson: newest.contentJson };
          latestContentRef.current = newest.content;
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

  // ===== 读取侧边栏宽度/收起设置 =====
  useEffect(() => {
    void getAppSettings()
      .then((cfg) => {
        setSidebarWidth(cfg.notesSidebarWidth ?? 160);
        setSidebarCollapsed(cfg.notesSidebarCollapsed ?? false);
      })
      .catch(() => {});
  }, []);

  // 侧边栏拖拽调宽：即时更新状态，松开时持久化
  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w);
    void updateAppSettings({ notesSidebarWidth: w });
  }, []);

  // 侧边栏收起/展开切换
  const handleSidebarToggleCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    void updateAppSettings({ notesSidebarCollapsed: next });
  }, [sidebarCollapsed]);

  // ===== 防抖自动保存 + beforeunload 同步兜底 + 卸载前 flush（统一委托 useAutoSaveDraft） =====
  const { schedule: scheduleSave, flushNow } = useAutoSaveDraft<DraftState | null>({
    data: draftRef.current,
    save: flushDraft,
    saveSync: () => {
      // A pending IPC write cannot be cancelled or ordered after sendSync here.
      // Refuse handoff instead of allowing its older snapshot to overwrite this one.
      if (inFlightRef.current) throw new Error('Note save in progress');
      const pending = prepareDraft();
      if (!pending) return;
      const { draft, input } = pending;
      if (!saveNoteSync(input).ok) throw new Error('Note save failed');
      const active = activeNoteRef.current;
      if (active) acceptSavedDraft(draft, { ...active, ...draft, id: input.id!, updatedAt: Date.now() });
    },
    onError: (error) => {
      showToast(error instanceof Error && error.message === 'Note save in progress'
        ? '笔记正在保存，草稿已保留，请稍后重试'
        : '笔记保存失败，草稿已保留，请检查磁盘空间或权限后重试');
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

  // Keep internal record changes and view unmounts in the same navigation lock.
  // The commit is synchronous so no other transition can pass a stale save check.
  const navigate = useCallback(async (commit: () => void, activate?: () => Promise<unknown>) => {
    if (navigationRef.current) {
      showToast('笔记正在保存或切换，请稍后重试');
      return;
    }
    navigationRef.current = true;
    try {
      try { await flushNow(); }
      catch { return; }
      if (activate) {
        try { await activate(); }
        catch { /* Active-note metadata does not discard the draft. */ }
        // Activation IPC can yield while the editor receives another change.
        try { await flushNow(); }
        catch { return; }
      }
      commit();
    } finally {
      navigationRef.current = false;
    }
  }, [flushNow, showToast]);

  const beforeLeave = useCallback((commit: () => void) => navigate(commit), [navigate]);

  const handleNew = useCallback(() => navigate(() => {
    // An untouched temporary note is not written to storage.
    const emptyNote: Note = {
      id: '', title: null, content: '', contentJson: '', pinned: false, tags: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    activeNoteRef.current = emptyNote;
    setActiveNoteState(emptyNote);
    draftRef.current = { id: null, title: null, content: '', contentJson: '' };
    latestContentRef.current = '';
  }, () => setActiveNote(null)), [navigate]);

  const handleSelectNote = useCallback((note: Note) => {
    if (note.id === activeNoteRef.current?.id) return Promise.resolve();
    return navigate(() => {
      activeNoteRef.current = note;
      setActiveNoteState(note);
      draftRef.current = {
        id: note.id, title: note.title, content: note.content, contentJson: note.contentJson,
      };
      latestContentRef.current = note.content;
    }, () => setActiveNote(note.id));
  }, [navigate]);

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
    // Keep a reserved id across edits while the first save is still pending.
    const id = draftRef.current?.id || activeNoteRef.current?.id || null;
    // 首行非空行作为标题，剥离 markdown 标题前缀（# ## ###）
    const firstLine = content.split('\n').find((l) => l.trim()) ?? '';
    const title = firstLine.replace(/^#{1,6}\s*/, '').trim() || null;
    draftRef.current = { id, title, content, contentJson };
    latestContentRef.current = content;
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

  // 存为提示词：弹出遮罩供用户再次修改
  const handleSaveAsPrompt = useCallback(() => {
    // 优先从 latestContentRef 读取（auto-save 清空 draftRef 后仍可用）
    const text = latestContentRef.current || activeNoteRef.current?.content || '';
    if (!text.trim()) return;
    // 标题从首行内容推导（剥离 markdown # 前缀）
    const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
    const title = firstLine.replace(/^#{1,6}\s*/, '').trim() || undefined;
    setSaveAsPromptContent(text);
    setSaveAsPromptTitle(title);
    setSaveAsPromptOpen(true);
  }, []);

  return {
    notes,
    activeNote,
    searchKeyword,
    setSearchKeyword,
    filterTag,
    setFilterTag,
    allTags,
    sidebarWidth,
    sidebarCollapsed,
    handleSidebarResize,
    handleSidebarToggleCollapse,
    toast,
    showToast,
    saveAsPromptOpen,
    saveAsPromptContent,
    saveAsPromptTitle,
    setSaveAsPromptOpen,
    beforeLeave,
    handleNew,
    handleSelectNote,
    handleDelete,
    handleContentChange,
    handleTogglePin,
    handleTagsChange,
    handleSendToAi,
    handleSaveAsPrompt,
  };
}
