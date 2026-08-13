/* =====================================================================
   lib/electron-api/freeze.ts —— 页面冻结 API 包装（防撤回保险）
   ===================================================================== */

import { requireElectron } from './core';

import type {
  FreezeAPI,
  FreezeSnapshot,
  FreezeState,
  FreezeActionResult,
  FreezeScrollResult,
  TextLayer,
  TextLayerGrapheme,
  TextLayerItem,
} from '../../../electron/shared/api/freeze.api';

export type { FreezeAPI, FreezeSnapshot, FreezeState, FreezeActionResult, FreezeScrollResult, TextLayer, TextLayerGrapheme, TextLayerItem };

/** 注册 webview 到冻结注册表（webview attach 后调用） */
export function registerFreezeWebview(payload: {
  tabId: string;
  windowId: string;
  profileId: string;
  webContentsId: number;
}): Promise<boolean> {
  const api = requireElectron();
  return api.freeze.registerWebview(payload);
}

/** 冻结指定 tab（先抓取对话入库 + 提取文本层再 pause） */
export async function freezeTab(payload: {
  tabId: string;
  profileId: string;
}): Promise<FreezeActionResult> {
  const api = requireElectron();
  return api.freeze.freezeTab(payload);
}

/** 按主进程真实状态冻结或恢复。 */
export function toggleFreeze(payload: { tabId: string; profileId: string }): Promise<FreezeActionResult> {
  const api = requireElectron();
  return api.freeze.toggle(payload);
}

/** 恢复指定 tab（解除冻结） */
export async function resumeFreeze(tabId: string): Promise<boolean> {
  const api = requireElectron();
  return api.freeze.resume(tabId);
}

/** 彻底分离调试器 */
export async function detachFreeze(tabId: string): Promise<boolean> {
  const api = requireElectron();
  return api.freeze.detach(tabId);
}

/** 查询冻结状态 */
export async function getFreezeStatus(tabId: string): Promise<FreezeState> {
  const api = requireElectron();
  return api.freeze.status(tabId);
}

/** 监听冻结状态变化 */
export function onFreezeStateChanged(
  callback: (payload: { tabId: string; state: FreezeState; revision: number }) => void,
): () => void {
  const api = requireElectron();
  return api.freeze.onStateChanged(callback);
}

/** 冻结态滚轮转发（选择层滚轮 → guest compositor 滚动画面） */
export function scrollFrozenTab(tabId: string, x: number, y: number, deltaX: number, deltaY: number): Promise<FreezeScrollResult | null> {
  const api = requireElectron();
  return api.freeze.scroll({ tabId, x, y, deltaX, deltaY });
}

/** 冻结态应用内置复制（选中文本 → 主进程写系统剪贴板） */
export function copyFrozenText(text: string): void {
  const api = requireElectron();
  api.freeze.copyText(text);
}
