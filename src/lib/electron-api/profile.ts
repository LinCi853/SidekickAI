/* =====================================================================
   lib/electron-api/profile.ts —— Profile 管理与指纹脚本
   ===================================================================== */

import type { Profile } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   Profile 管理 —— 对应 window.electron.profile
   ===================================================================== */

/** 加载全部 Profile 列表 */
export async function listProfiles(): Promise<Profile[]> {
  const api = requireElectron();
  return api.profile.list();
}

/** 创建 Profile（合并默认值后由主进程持久化） */
export async function createProfile(partial: Partial<Profile>): Promise<Profile> {
  const api = requireElectron();
  return api.profile.create(partial);
}

/** 更新 Profile（合并 patch，嵌套对象深合并） */
export async function updateProfile(id: string, patch: Partial<Profile>): Promise<Profile> {
  const api = requireElectron();
  return api.profile.update(id, patch);
}

/** 删除 Profile */
export async function deleteProfile(id: string): Promise<void> {
  const api = requireElectron();
  return api.profile.delete(id);
}

/** 复制 Profile（生成新 id） */
export async function duplicateProfile(id: string): Promise<Profile> {
  const api = requireElectron();
  return api.profile.duplicate(id);
}

/**
 * 拖拽排序：按 orderedIds 顺序重置 Profile 的 order 字段。
 * 主进程持久化后向所有窗口广播 PROFILE_REORDERED。
 */
export async function reorderProfiles(orderedIds: string[]): Promise<boolean> {
  const api = requireElectron();
  return api.profile.reorder(orderedIds);
}

/**
 * 监听 Profile 被任意窗口更新后的广播（跨窗口同步）。
 * 当任意窗口调用 updateProfile 后，主进程向所有窗口广播 { id, profile }。
 * 返回取消监听函数。
 */
export function onProfileUpdated(
  callback: (data: { id: string; profile: Profile }) => void,
): () => void {
  const api = requireElectron();
  return api.profile.onUpdated(callback);
}

/**
 * 监听 Profile 新建/复制后的广播（跨窗口同步新增卡片）。
 * 主进程在 PROFILE_CREATE / PROFILE_DUPLICATE 完成后向所有窗口广播新建的 Profile。
 * 返回取消监听函数。
 */
export function onProfileCreated(callback: (profile: Profile) => void): () => void {
  const api = requireElectron();
  return api.profile.onCreated(callback);
}

/**
 * 监听 Profile 删除后的广播（跨窗口同步移除卡片、关闭相关 tab）。
 * 主进程在 PROFILE_DELETE 完成后（含窗口关闭 + session 清理）向所有窗口广播 profileId。
 * 返回取消监听函数。
 */
export function onProfileDeleted(callback: (profileId: string) => void): () => void {
  const api = requireElectron();
  return api.profile.onDeleted(callback);
}

/**
 * 监听 Profile 拖拽排序后的广播（跨窗口同步顺序）。
 * 参数为新顺序的 profile id 数组，渲染层收到后重新拉取 profiles 或就地重排。
 * 返回取消监听函数。
 */
export function onProfileReordered(callback: (orderedIds: string[]) => void): () => void {
  const api = requireElectron();
  return api.profile.onReordered(callback);
}

/** 打开 AI 应用编辑窗口（编辑模式按 profileId 单例，新建模式固定 'create' 单例） */
export function openAiAppEditor(opts: {
  platformId?: string;
  profileId?: string;
  mode?: 'edit' | 'create';
}): Promise<void> {
  const api = requireElectron();
  return api.openAiAppEditor(opts);
}

/** 打开设置独立窗口（单例，左导航+右内容布局） */
export function openSettingsWindow(): Promise<void> {
  const api = requireElectron();
  return api.openSettingsWindow();
}

/**
 * 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）。
 * 可选 providerId：若提供则切换到对应自定义供应商的对话页。
 */
export function openAdvancedPanelWindow(providerId?: string): Promise<void> {
  const api = requireElectron();
  return api.openAdvancedPanelWindow(providerId);
}

/** 监听单例窗口复用时的 tab/provider 切换通知 */
export function onAdvancedPanelNavigate(
  callback: (payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) => void,
): () => void {
  const api = requireElectron();
  return api.onAdvancedPanelNavigate(callback);
}

/**
 * 监听 UI 比例变化广播（主进程在 uiScale 变更后向所有窗口推送）。
 * 渲染层收到后重新计算当前窗口最小尺寸并调用 setMinimumSize。
 */
export function onUiScaleChanged(
  callback: (uiScale: 'small' | 'medium' | 'large') => void,
): () => void {
  const api = requireElectron();
  return api.onUiScaleChanged(callback);
}

/**
 * 监听应用设置变更广播（任意窗口修改设置后，主进程向所有窗口推送最新设置）。
 * 渲染层收到后可同步更新本地状态（顶栏按钮、标签栏、主题等）。
 */
export function onAppSettingsChanged(
  callback: (settings: import('../../../electron/shared/types').AppSettings) => void,
): () => void {
  const api = requireElectron();
  return api.onAppSettingsChanged(callback);
}

/**
 * 请求广播 UI 版本/主题变更到所有窗口（Oxy Design System 切换 / 主题模式切换时调用）。
 * 调用后主进程向所有 BrowserWindow 推送最新 uiVersion + theme。
 */
export function broadcastUiVersionChanged(payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }): void {
  const api = requireElectron();
  api.broadcastUiVersionChanged(payload);
}

/**
 * 监听 UI 版本/主题变更广播（任意窗口切换 Oxy 或主题后，主进程向所有窗口推送）。
 * 渲染层收到后应同步应用 DOM 变更并更新本地状态。
 */
export function onUiVersionChanged(
  callback: (payload: { uiVersion: 'classic' | 'oxy'; theme: 'light' | 'dark' | 'system' }) => void,
): () => void {
  const api = requireElectron();
  return api.onUiVersionChanged(callback);
}

/**
 * 请求广播 Oxy 主题色变更到所有窗口（主窗口切换 AI 应用时调用）。
 */
export function broadcastThemeColorChanged(hex: string): void {
  const api = requireElectron();
  api.broadcastThemeColorChanged(hex);
}

/**
 * 监听 Oxy 主题色变更广播（主窗口切换 AI 应用后，主进程向所有窗口推送）。
 */
export function onThemeColorChanged(callback: (hex: string) => void): () => void {
  const api = requireElectron();
  return api.onThemeColorChanged(callback);
}

/* =====================================================================
   指纹脚本 —— 对应 window.electron.fingerprint
   ===================================================================== */

/**
 * 获取指定 Profile 的指纹注入脚本（IIFE 字符串）。
 * 单页架构：渲染进程在 <webview> dom-ready 后调用 webview.executeJavaScript 注入。
 */
export async function getFingerprintScript(profileId: string): Promise<string> {
  const api = requireElectron();
  return api.fingerprint.getScript(profileId);
}
