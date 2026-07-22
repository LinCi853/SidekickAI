/* =====================================================================
   lib/electron-api/notes.ts —— 灵感笔记（需求 11）
   对应 window.electron.notes：浮窗 CRUD + 发送到 AI 输入框 + 存为提示词
   ===================================================================== */

import type { Note, NoteSaveInput } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   灵感笔记 —— 对应 window.electron.notes
   ===================================================================== */

/** 列出全部笔记（按 updatedAt 降序） */
export async function listNotes(): Promise<Note[]> {
  const api = requireElectron();
  return api.notes.list();
}

/** 新增或更新笔记（upsert 语义：无 id 新增，有 id 更新） */
export async function saveNote(input: NoteSaveInput): Promise<Note> {
  const api = requireElectron();
  return api.notes.save(input);
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

/**
 * 发送笔记内容到当前 AI 输入框。
 * 主进程查找 lastFocusedWin（非笔记窗口），通过 VOICE_INJECT_AND_SEND 通道
 * 把文本注入其激活的 AI 输入框（webview textarea / 自定义对话输入框）。
 * enterToSend 控制是否自动回车发送。
 */
export async function sendNoteToAi(
  text: string,
  enterToSend?: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.notes.sendToAi(text, enterToSend);
}

/**
 * 把笔记内容保存为新的提示词模板。
 * 标题取自首行（截断 30 字符），分类默认 '笔记'。
 */
export async function saveNoteAsPrompt(
  content: string,
  title?: string,
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const api = requireElectron();
  return api.notes.saveAsPrompt(content, title);
}

/** 监听主进程 → 笔记窗口渲染：注入结果回传（success + error?） */
export function onNoteInjectResult(
  callback: (result: { success: boolean; error?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.notes.onInjectResult(callback);
}
