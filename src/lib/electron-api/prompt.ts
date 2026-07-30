/* =====================================================================
   lib/electron-api/prompt.ts —— 提示词模板（明输入明注入）
   ===================================================================== */

import type { PromptTemplate } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   提示词模板（明输入明注入）—— 对应 window.electron.prompt
   ===================================================================== */

/** 读取全部提示词模板 */
export async function listPrompts(): Promise<PromptTemplate[]> {
  const api = requireElectron();
  return api.prompt.list();
}

/** 新增或更新提示词模板（按 id upsert） */
export async function savePrompt(template: PromptTemplate): Promise<PromptTemplate> {
  const api = requireElectron();
  return api.prompt.save(template);
}

/** 删除提示词模板 */
export async function deletePrompt(id: string): Promise<void> {
  const api = requireElectron();
  return api.prompt.delete(id);
}

/** 打开提示词库独立窗口（单例，不遮挡主页面） */
export async function openPromptWindow(): Promise<void> {
  const api = requireElectron();
  return api.prompt.openWindow();
}

/** 导出全部提示词为 JSON 文件（主进程弹保存对话框 + 写文件） */
export async function exportPrompts(): Promise<{
  ok: boolean;
  filePath?: string;
  canceled?: boolean;
  error?: string;
}> {
  const api = requireElectron();
  return api.prompt.exportPrompts();
}

/** 导入提示词 JSON 文件（主进程弹打开对话框 + 读文件 + 合并入库） */
export async function importPrompts(): Promise<{
  ok: boolean;
  added?: number;
  updated?: number;
  canceled?: boolean;
  error?: string;
}> {
  const api = requireElectron();
  return api.prompt.importPrompts();
}

/** 请求注入模板到主窗口激活 webview（提示词库窗口 → 主进程 → 主窗口渲染）
 *  需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
 */
export async function requestPromptInject(template: PromptTemplate): Promise<void> {
  const api = requireElectron();
  return api.prompt.requestInject(template);
}

/** 监听提示词注入请求（主→主窗口渲染：提示词库窗口请求注入激活 webview）
 *  需求 1：回调接收完整 PromptTemplate，由主窗口执行 composeFinalText 后注入
 */
export function onPromptInjectRequest(callback: (template: PromptTemplate) => void): () => void {
  const api = requireElectron();
  return api.onPromptInjectRequest(callback);
}

/** 监听提示词注入结果（主→提示词库窗口渲染：注入成功/失败回传） */
export function onPromptInjectResult(
  callback: (result: { success: boolean; platformName?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.onPromptInjectResult(callback);
}

/** 回传注入结果到提示词库窗口（主窗口渲染 → 主进程 → 提示词库窗口渲染，供其显示 toast） */
export function sendPromptInjectResult(result: { success: boolean; platformName?: string }): void {
  const api = requireElectron();
  return api.sendPromptInjectResult(result);
}
