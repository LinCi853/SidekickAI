/* =====================================================================
   lib/electron-api/freeze.ts —— 页面冻结 API 包装（防撤回保险）
   ===================================================================== */

import { requireElectron } from './core';

import type { FreezeAPI, FreezeSnapshot, FreezeState } from '../../../electron/shared/api/freeze.api';

export type { FreezeAPI, FreezeSnapshot, FreezeState };

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

/** 冻结指定 tab（先抓取对话入库再 pause） */
export async function freezeTab(payload: {
  tabId: string;
  profileId: string;
  rect?: { x: number; y: number; width: number; height: number };
  dpr?: number;
}): Promise<{ frozen: boolean; snapshot: FreezeSnapshot | null }> {
  const api = requireElectron();
  return api.freeze.freezeTab(payload);
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
  callback: (payload: { tabId: string; state: FreezeState }) => void,
): () => void {
  const api = requireElectron();
  return api.freeze.onStateChanged(callback);
}

/** 监听窗口 move/resize 后主进程请求重新上报 webview 位置 */
export function onFreezeSyncRect(
  callback: (payload: { tabIds: string[] }) => void,
): () => void {
  const api = requireElectron();
  return api.freeze.onSyncRect(callback);
}

/** 上报 webview 位置（窗口内 CSS 像素 + dpr） */
export function reportFreezeRect(payload: {
  tabId: string;
  rect: { x: number; y: number; width: number; height: number };
  dpr: number;
}): void {
  const api = requireElectron();
  api.freeze.reportRect(payload);
}

/** 计算指定 tab 的 webview 元素在窗口内的位置（CSS 像素） */
export function getWebviewRect(tabId: string): { rect: { x: number; y: number; width: number; height: number }; dpr: number } | null {
  const wv = document.querySelector(`webview[data-tab-id="${tabId}"]`) as HTMLElement | null;
  if (!wv || !wv.getBoundingClientRect) return null;
  const r = wv.getBoundingClientRect();
  return {
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    dpr: window.devicePixelRatio || 1,
  };
}
