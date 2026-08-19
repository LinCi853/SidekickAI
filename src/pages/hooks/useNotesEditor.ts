/* =====================================================================
   pages/hooks/useNotesEditor.ts —— 灵感笔记编辑器逻辑 Hook
   从 NotesEditor 组件抽离的 markdown 编辑器逻辑：
   - markdownText 受控状态 + 编辑/预览模式切换
   - Markdown 快捷键（Ctrl+B / Ctrl+I / Ctrl+K / Ctrl+E）
   - 内容变化处理 + 光标位置持久化 + 图片粘贴/拖拽
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from 'react';
import { getAppSettings } from '../../lib/electron-api/settings.js';
import { saveNotesImage } from '../../lib/electron-api/notes.js';
import type { Note } from '../../../electron/shared/types.js';

export type NotesEditorMode = 'source' | 'preview';

export interface UseNotesEditorResult {
  markdownText: string;
  mode: NotesEditorMode;
  setMode: (mode: NotesEditorMode) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  handleContentChange: (value: string) => void;
  insertSyntax: (before: string, after?: string, placeholder?: string) => void;
  insertLinePrefix: (prefix: string) => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: DragEvent<HTMLTextAreaElement>) => void;
  saveCursorPosition: () => void;
}

export function useNotesEditor(
  note: Note | null,
  onContentChange: (content: string, contentJson: string) => void,
): UseNotesEditorResult {
  // 编辑模式：'source' = 编辑 markdown 源码；'preview' = 渲染预览
  const [mode, setMode] = useState<NotesEditorMode>('source');
  // 编辑器内的 markdown 源码（受控）
  const [markdownText, setMarkdownText] = useState(note?.content ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 光标位置持久化 key
  const CURSOR_STORAGE_KEY = 'notes-cursor-positions';

  // 从 localStorage 读取光标位置
  const getCursorPos = useCallback((noteId: string): number | null => {
    try {
      const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
      if (!raw) return null;
      const map = JSON.parse(raw) as Record<string, number>;
      return map[noteId] ?? null;
    } catch { return null; }
  }, []);

  // 保存光标位置到 localStorage
  const setCursorPos = useCallback((noteId: string, pos: number) => {
    try {
      const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
      const map = raw ? JSON.parse(raw) as Record<string, number> : {};
      map[noteId] = pos;
      localStorage.setItem(CURSOR_STORAGE_KEY, JSON.stringify(map));
    } catch { /* ignore */ }
  }, []);

  // 笔记切换时同步内容到编辑器；始终进入编辑模式，恢复上次光标位置
  useEffect(() => {
    const content = note?.content ?? '';
    setMarkdownText(content);
    setMode('source');
  }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 编辑模式下自动聚焦并恢复光标位置
  useEffect(() => {
    if (mode !== 'source') return;
    const ta = textareaRef.current;
    if (!ta) return;
    // 先获取设置，再用 rAF 确保 DOM 更新后设置光标
    void getAppSettings().then((cfg) => {
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        const noteId = note?.id ?? '';
        const savedPos = cfg.notesRestoreCursor !== false ? getCursorPos(noteId) : null;
        const pos = savedPos != null ? Math.min(savedPos, textareaRef.current.value.length) : textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(pos, pos);
      });
    }).catch(() => {
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
        }
      });
    });
  }, [note?.id, mode, getCursorPos]);

  // 保存当前光标位置（编辑时实时记录）
  const saveCursorPosition = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || !note?.id) return;
    setCursorPos(note.id, ta.selectionStart);
  }, [note?.id, setCursorPos]);

  const handleContentChange = (value: string) => {
    setMarkdownText(value);
    saveCursorPosition();
    // contentJson 传空字符串（已废弃 TipTap JSON，新笔记存 markdown 字符串到 content）
    onContentChange(value, '');
  };

  /** 在 textarea 当前光标位置插入 markdown 语法标记 */
  const insertSyntax = useCallback((before: string, after: string = '', placeholder: string = '') => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = markdownText.slice(start, end) || placeholder;
    const newText = markdownText.slice(0, start) + before + selected + after + markdownText.slice(end);
    handleContentChange(newText);
    // 恢复光标到选中内容后
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + before.length + selected.length + after.length;
      ta.setSelectionRange(start + before.length, pos);
    });
  }, [markdownText]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 在行首插入前缀（如 # / - / - [ ]） */
  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const lineStart = markdownText.lastIndexOf('\n', start - 1) + 1;
    const newText = markdownText.slice(0, lineStart) + prefix + markdownText.slice(lineStart);
    handleContentChange(newText);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  }, [markdownText]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 在光标位置插入指定文本（不包裹选区，用于图片插入） */
  const insertText = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newText = markdownText.slice(0, start) + text + markdownText.slice(end);
    handleContentChange(newText);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  }, [markdownText]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 粘贴处理：检测图片类型，保存为 notes-asset:// 并插入 markdown 图片语法 */
  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const result = await saveNotesImage(dataUrl);
          if (result.ok && result.url) {
            insertText(`\n![图片](${result.url})\n`);
          }
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }, [insertText]);

  /** 拖拽处理：检测图片文件，保存为 notes-asset:// 并插入 markdown 图片语法 */
  const handleDrop = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    e.preventDefault();
    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const result = await saveNotesImage(dataUrl);
        if (result.ok && result.url) {
          insertText(`\n![图片](${result.url})\n`);
        }
      };
      reader.readAsDataURL(file);
    }
  }, [insertText]);

  /** Markdown 快捷键：Ctrl+B 加粗 / Ctrl+I 斜体 / Ctrl+K 代码 / Ctrl+E 任务项 */
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    switch (e.key.toLowerCase()) {
      case 'b':
        e.preventDefault();
        insertSyntax('**', '**', '粗体');
        break;
      case 'i':
        e.preventDefault();
        insertSyntax('*', '*', '斜体');
        break;
      case 'k':
        e.preventDefault();
        insertSyntax('`', '`', '代码');
        break;
      case 'e':
        e.preventDefault();
        insertLinePrefix('- [ ] ');
        break;
    }
  }, [insertSyntax, insertLinePrefix]);

  return {
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
  };
}
