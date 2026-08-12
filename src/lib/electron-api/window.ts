/* =====================================================================
   lib/electron-api/window.ts —— 窗口管理 / 窗口控制 / 窗口状态 / 标签 / 设备预设 / AI平台 / 新标签事件
   ===================================================================== */

import type { WindowStateData, DevicePreset, AIPlatform } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   窗口管理 —— 对应 window.electron.window
   ===================================================================== */

/** 打开 Profile 窗口（已打开则聚焦） */
export async function openWindow(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.window.open(profileId);
}

/** 关闭指定 Profile 窗口 */
export async function closeWindow(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.window.close(profileId);
}

/** 运行时切换 UA（不重建窗口） */
export async function switchWindowUA(profileId: string, ua: string): Promise<void> {
  const api = requireElectron();
  return api.window.switchUA(profileId, ua);
}

/** 切换设备预设 */
export async function switchWindowDevice(profileId: string, presetId: string): Promise<void> {
  const api = requireElectron();
  return api.window.switchDevice(profileId, presetId);
}

/** 设置窗口置顶 */
export async function setWindowAlwaysOnTop(profileId: string, onTop: boolean): Promise<void> {
  const api = requireElectron();
  return api.window.setAlwaysOnTop(profileId, onTop);
}

/** 获取所有已打开窗口的 profileId 列表 */
export async function getOpenWindowIds(): Promise<string[]> {
  const api = requireElectron();
  return api.window.getOpenWindowIds();
}

/**
 * 为嵌入式 <webview> 准备 session（单页架构专用）。
 */
export async function setupSession(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.window.setupSession(profileId);
}

/* =====================================================================
   窗口控制 —— 对应 window.electron.windowControl
   ===================================================================== */

export async function minimizeWindow(): Promise<void> {
  const api = requireElectron();
  return api.windowControl.minimize();
}

export async function maximizeToggleWindow(): Promise<boolean> {
  const api = requireElectron();
  return api.windowControl.maximizeToggle();
}

/** 关闭调用方所在窗口本身（区别于 profile 级 closeWindow） */
export async function closeCurrentWindow(): Promise<void> {
  const api = requireElectron();
  return api.windowControl.close();
}

/** 设置调用方所在窗口本身置顶（区别于 profile 级 setWindowAlwaysOnTop） */
export async function pinCurrentWindow(onTop: boolean): Promise<boolean> {
  const api = requireElectron();
  return api.windowControl.setAlwaysOnTop(onTop);
}

export async function isWindowMaximized(): Promise<boolean> {
  const api = requireElectron();
  return api.windowControl.isMaximized();
}

/** 查询当前窗口的实际置顶状态（win.isAlwaysOnTop()，非持久化值） */
export async function isWindowAlwaysOnTop(): Promise<boolean> {
  const api = requireElectron();
  return api.windowControl.isAlwaysOnTop();
}

export async function getWindowBounds(): Promise<{ x?: number; y?: number; width: number; height: number }> {
  const api = requireElectron();
  return api.windowControl.getBounds();
}

/** 将标签脱离当前窗口，弹出为独立窗口 */
export async function detachTab(tabId: string): Promise<void> {
  const api = requireElectron();
  return api.windowControl.detachTab(tabId);
}

/** 自定义边缘拖拽 resize：直接设置窗口 bounds */
export async function resizeWindow(bounds: { x?: number; y?: number; width: number; height: number }): Promise<void> {
  const api = requireElectron();
  return api.windowControl.resize(bounds);
}

/**
 * 动态设置当前窗口的最小尺寸（UI 比例变化时重新约束窗口尺寸）。
 * 主进程通过 BrowserWindow.setMinimumSize 设置调用方所在窗口。
 */
export async function setMinimumSize(width: number, height: number): Promise<void> {
  const api = requireElectron();
  return api.windowControl.setMinimumSize(width, height);
}

/** 切换当前窗口全屏状态 */
export async function toggleFullscreenWindow(): Promise<boolean> {
  const api = requireElectron();
  return api.windowControl.toggleFullscreen();
}

/**
 * 获取当前窗口的最小尺寸（主进程 BrowserWindow.getMinimumSize）。
 * 用于 resize 拖拽时动态获取真实下限，而非硬编码。
 */
export async function getMinimumSize(): Promise<{ width: number; height: number }> {
  const api = requireElectron();
  return api.windowControl.getMinimumSize();
}

/**
 * 监听最大化状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
 * 返回取消监听的函数。
 */
export function onMaximizeToggled(
  callback: (isMaximized: boolean) => void,
): () => void {
  const api = requireElectron();
  return api.windowControl.onMaximizeToggled(callback);
}

/**
 * 监听置顶状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
 * 返回取消监听的函数。
 */
export function onPinToggled(
  callback: (alwaysOnTop: boolean) => void,
): () => void {
  const api = requireElectron();
  return api.windowControl.onPinToggled(callback);
}

/**
 * 监听全屏状态变更事件（主进程切换全屏时通知渲染层，
 * 用于置顶按钮禁用态等与全屏互斥的 UI 同步）。
 * 返回取消监听的函数。
 */
export function onFullscreenToggled(
  callback: (isFullscreen: boolean) => void,
): () => void {
  const api = requireElectron();
  return api.windowControl.onFullscreenToggled(callback);
}

/* =====================================================================
   窗口状态持久化 —— 对应 window.electron.windowState
   ===================================================================== */

export async function getWindowState(windowId: string): Promise<WindowStateData | null> {
  const api = requireElectron();
  return api.windowState.get(windowId);
}

export async function saveWindowState(windowId: string, state: WindowStateData): Promise<void> {
  const api = requireElectron();
  return api.windowState.save(windowId, state);
}

/* =====================================================================
   标签管理 —— 对应 window.electron.tab
   ===================================================================== */

export async function updateTabTitle(windowId: string, tabId: string, title: string): Promise<void> {
  const api = requireElectron();
  return api.tab.updateTitle(windowId, tabId, title);
}

export async function updateTabUrl(windowId: string, tabId: string, url: string): Promise<void> {
  const api = requireElectron();
  return api.tab.updateUrl(windowId, tabId, url);
}

export async function updateTabHomeUrl(windowId: string, tabId: string, homeUrl: string): Promise<void> {
  const api = requireElectron();
  return api.tab.updateHomeUrl(windowId, tabId, homeUrl);
}

/**
 * 监听窗口快捷键兜底请求（主→渲染）。
 * 主进程在主窗口无该 Profile 标签时，请求渲染层创建标签并返回 tabId。
 */
export function onTabEnsureAndDetach(callback: (profileId: string) => void): () => void {
  const api = requireElectron();
  return api.tab.onEnsureAndDetach(callback);
}

/** 回复兜底请求结果给主进程（tabId 或 null） */
export function reportTabEnsureAndDetachResult(payload: { profileId: string; tabId: string | null }): void {
  const api = requireElectron();
  return api.tab.reportEnsureAndDetachResult(payload);
}

/* =====================================================================
   设备预设 / AI 平台 —— 对应 window.electron.presets / aiPlatform
   ===================================================================== */

/** 获取全部设备预设列表 */
export async function listPresets(): Promise<DevicePreset[]> {
  const api = requireElectron();
  return api.presets.list();
}

/** 按 id 获取设备预设 */
export async function getPreset(id: string): Promise<DevicePreset | null> {
  const api = requireElectron();
  return api.presets.get(id);
}

/** 新增或更新设备预设（upsert 语义，按 id 匹配） */
export async function savePreset(preset: DevicePreset): Promise<DevicePreset> {
  const api = requireElectron();
  return api.presets.save(preset);
}

/** 删除设备预设 */
export async function deletePreset(id: string): Promise<void> {
  const api = requireElectron();
  return api.presets.delete(id);
}

/** 获取全部内置 AI 平台（预置列表，无 Profile 合并） */
export function getPresetAIPlatforms(): AIPlatform[] {
  const api = requireElectron();
  return api.aiPlatform.presetList?.() ?? [];
}

/** 获取全部内置 AI 平台（合并 Profile 自定义覆盖） */
export async function listAIPlatforms(): Promise<AIPlatform[]> {
  const api = requireElectron();
  return api.aiPlatform.list();
}

/* =====================================================================
   新标签页事件（主进程 → 渲染层：拦截 webview 弹窗后新建标签）
   ===================================================================== */

/**
 * 监听 webview 弹窗 URL 转发事件（主进程拦截 window.open / target="_blank" 后，
 * 将 URL + guest webContents id 发回渲染层）。渲染层收到后按 webContentsId 匹配
 * 到对应的 webview 标签，调用其 loadURL 在当前 tab 内导航（页面内跳转，不弹新窗口）。
 * 返回取消监听的函数。
 */
export function onWebviewPopupUrl(
  callback: (payload: { url: string; webContentsId: number }) => void,
): () => void {
  const api = requireElectron();
  return api.onWebviewPopupUrl(callback);
}

/**
 * 监听窗口重新显示/聚焦到前台事件（主进程 show/focus 后触发）。
 * 用于每次唤出窗口时聚焦 AI 输入框。返回取消监听的函数。
 */
export function onWindowShown(callback: () => void): () => void {
  const api = requireElectron();
  return api.onWindowShown(callback);
}

/**
 * 监听窗口隐藏事件（主进程 hide 时触发）。
 * 用于自动收起展开的面板（底栏等），避免用户下次展开不能直接到文本输入区。
 * 返回取消监听的函数。
 */
export function onWindowHidden(callback: () => void): () => void {
  const api = requireElectron();
  return api.onWindowHidden(callback);
}

/**
 * 监听弹窗被连续拦截事件（主进程拦截 popup 达到阈值后通知渲染层提示用户加白）。
 * 返回取消监听的函数。
 */
export function onPopupDenied(
  callback: (data: { origin: string; count: number }) => void,
): () => void {
  const api = requireElectron();
  return api.onPopupDenied(callback);
}

/** 添加 origin 到全局弹窗白名单 */
export async function addToPopupWhitelist(origin: string): Promise<void> {
  const api = requireElectron();
  return api.addToPopupWhitelist(origin);
}

/** 添加 origin 到 Profile 专属弹窗白名单 */
export async function addToProfilePopupWhitelist(profileId: string, origin: string): Promise<void> {
  const api = requireElectron();
  return api.addToProfilePopupWhitelist(profileId, origin);
}

/**
 * 监听 webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行）。
 * 统一拦截点：Alt+1~9 / Ctrl+Tab / Ctrl+G / ` / ? 等快捷键在 webview 焦点时也能生效。
 */
export function onWebviewHotkey(
  callback: (payload: {
    action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'forceRefresh' | 'newTab' | 'closeTab' | 'detachCurrent' | 'toggleFreeze' | 'toggleFullscreen' | 'focusCycle' | 'addBookmark' | 'openHistory' | 'openDownloads' | 'focusSearch' | 'clearBrowsingData' | 'findInPage' | 'print';
    data?: unknown;
  }) => void,
): () => void {
  const api = requireElectron();
  return api.onWebviewHotkey(callback);
}


