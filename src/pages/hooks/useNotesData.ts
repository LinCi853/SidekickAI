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
    latestContentRef.current = '';
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
    latestContentRef.current = note.content;
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
