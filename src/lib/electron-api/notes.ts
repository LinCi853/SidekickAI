/* =====================================================================
   lib/electron-api/notes.ts —— 灵感笔记（v2：SQLite + FTS5 + 富文本 + 分类）
   对应 window.electron.notes
   ===================================================================== */

import type { Note, NoteListFilter, NoteSaveInput } from '../../../electron/shared/types';
import { requireElectron } from './core';

/** 列出笔记（支持搜索/标签/置顶筛选，按 pinned DESC, updatedAt DESC） */
export async function listNotes(filter?: NoteListFilter): Promise<Note[]> {
  const api = requireElectron();
  return api.notes.list(filter);
}

/** 新增或更新笔记（upsert 语义：无 id 新增，有 id 更新） */
export async function saveNote(input: NoteSaveInput): Promise<Note> {
  const api = requireElectron();
  return api.notes.save(input);
}

/** 同步保存（beforeunload 兜底，sendSync 确保窗口关闭前完成写入） */
export function saveNoteSync(input: NoteSaveInput): { ok: boolean } {
  const api = requireElectron();
  return api.notes.saveSync(input);
}

/** 删除笔记 */
export async function deleteNote(id: string): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.notes.delete(id);
}

/** 获取当前激活的笔记（null=无激活） */
export async function getActiveNote(): Promise<Note | null> {
  const api = requireElectron();
  return api.notes.getActive();
}

/** 设置激活笔记（null=取消激活） */
export async function setActiveNote(id: string | null): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.notes.setActive(id);
}

/** 设置置顶 */
export async function setNotePinned(id: string, pinned: boolean): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.notes.setPinned(id, pinned);
}

/** 设置标签 */
export async function setNoteTags(id: string, tags: string[]): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.notes.setTags(id, tags);
}

/** 列出全部已用标签（去重） */
export async function listNoteTags(): Promise<string[]> {
  const api = requireElectron();
  return api.notes.listTags();
}

/** 发送笔记内容到当前 AI 输入框 */
export async function sendNoteToAi(
  text: string,
  enterToSend?: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.notes.sendToAi(text, enterToSend);
}

/** 把笔记内容保存为新的提示词模板 */
export async function saveNoteAsPrompt(
  content: string,
  title?: string,
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const api = requireElectron();
  return api.notes.saveAsPrompt(content, title);
}

/** 保存图片到磁盘，返回 notes-asset:// 路径（用于 markdown 中引用粘贴/拖拽的图片） */
export async function saveNotesImage(
  dataUrl: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const api = requireElectron();
  return api.notes.saveImage(dataUrl);
}

/** 监听主进程 → 笔记窗口渲染：注入结果回传 */
export function onNoteInjectResult(
  callback: (result: { success: boolean; error?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.notes.onInjectResult(callback);
}
