/* =====================================================================
   lib/electron-api/browser.ts —— 浏览器窗口 API / 导航历史 API
   ===================================================================== */

import type {
  BrowserWindowState,
  BrowserDownloadRecord,
  SearchHistoryEntry,
  NavHistoryEntry,
  BrowserTabState,
  TabState,
} from '../../../electron/shared/types';
import type {
  Bookmark,
  BookmarkInput,
  BookmarkFilter,
  BookmarkPatch,
} from '../../../electron/shared/bookmark.types';
import { requireElectron } from './core';

// re-export 书签类型，供渲染层通过 electron-api 桶导出使用
export type { Bookmark, BookmarkInput, BookmarkFilter, BookmarkPatch };

/* =====================================================================
   浏览器窗口 —— 对应 window.electron.browser
   ===================================================================== */

/** 读取浏览器窗口状态（按 windowId） */
export async function getBrowserState(windowId: string): Promise<BrowserWindowState | null> {
  const api = requireElectron();
  return api.browser.getState(windowId);
}

/** 保存浏览器窗口状态（整体覆盖） */
export async function saveBrowserState(windowId: string, state: BrowserWindowState): Promise<void> {
  const api = requireElectron();
  return api.browser.saveState(windowId, state);
}

/** 在系统默认浏览器中打开 URL */
export async function openExternal(url: string): Promise<void> {
  const api = requireElectron();
  return api.browser.openExternal(url);
}

/** 记录一条搜索历史 */
export async function addSearchHistory(entry: { profileId: string; query: string; url: string }): Promise<void> {
  const api = requireElectron();
  return api.browser.addSearchHistory(entry);
}

/** 查询搜索历史（按 profileId，可选关键词过滤，按时间倒序） */
export async function listSearchHistory(profileId: string, keyword?: string, limit?: number): Promise<SearchHistoryEntry[]> {
  const api = requireElectron();
  return api.browser.listSearchHistory(profileId, keyword, limit);
}

/** 列出下载记录（可选按 windowId 过滤，按时间倒序） */
export async function listBrowserDownloads(windowId?: string, limit?: number): Promise<BrowserDownloadRecord[]> {
  const api = requireElectron();
  return api.browser.listDownloads(windowId, limit);
}

/** 打开已下载文件 */
export async function openDownloadFile(id: string): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.openDownloadFile(id);
}

/** 在文件管理器中显示已下载文件 */
export async function showDownloadInFolder(id: string): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.showDownloadInFolder(id);
}

/** 主→渲染：下载状态变化推送。返回取消监听函数。 */
export function onDownloadUpdated(callback: (record: BrowserDownloadRecord) => void): () => void {
  const api = requireElectron();
  return api.browser.onDownloadUpdated(callback);
}

/** 主→渲染：F12 切换 DevTools。返回取消监听函数。 */
export function onToggleDevTools(callback: () => void): () => void {
  const api = requireElectron();
  return api.browser.onToggleDevTools(callback);
}

/** 主→渲染：F11 切换全屏。返回取消监听函数。 */
export function onToggleFullscreen(callback: () => void): () => void {
  const api = requireElectron();
  return api.browser.onToggleFullscreen(callback);
}

/* =====================================================================
   导航历史 —— 对应 window.electron.navHistory
   ===================================================================== */

/** 记录一次导航（内存存储，同 URL 连续去重） */
export async function recordNavHistory(profileId: string, entry: NavHistoryEntry): Promise<void> {
  const api = requireElectron();
  return api.navHistory.record(profileId, entry);
}

/** 获取某 Profile 的全部导航历史 */
export async function getNavHistory(profileId: string): Promise<NavHistoryEntry[]> {
  const api = requireElectron();
  return api.navHistory.get(profileId);
}

/** 清除某 Profile 的导航历史 */
export async function clearNavHistory(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.navHistory.clear(profileId);
}

/** 浏览器窗口关闭时，将当前标签迁移回主窗口 */
export function browserTabMigrateBack(payload: {
  profileId: string;
  url: string;
  title: string;
  /** v0.0.9: 所有标签的最终 URL（按 parentTabId 精确恢复多标签） */
  finalUrls?: Array<{ tabId: string; url: string; title: string }>;
}): void {
  const api = requireElectron();
  api.browser.tabMigrateBack(payload);
}

/** 监听浏览器窗口标签迁移回主窗口的事件（主窗口渲染层使用） */
export function onBrowserTabMigrateBack(
  callback: (payload: { profileId: string; url: string; title: string; finalUrls?: Array<{ tabId: string; url: string; title: string }> }) => void,
): () => void {
  const api = requireElectron();
  return api.browser.onTabMigrateBack(callback);
}

/** 监听标签脱离到浏览器窗口的事件（主窗口渲染层使用，用于隐藏标签） */
export function onBrowserTabDetached(
  callback: (profileId: string, newActiveTabId: string | null) => void,
): () => void {
  const api = requireElectron();
  return api.browser.onTabDetached(callback);
}

/* =====================================================================
   跨窗口标签聚合查询 —— v0.0.9 主子标签归属
   ===================================================================== */

/** 跨窗口标签聚合查询返回结构 */
export interface AllTabsTree {
  /** 主窗口标签（TabState[]，含 detachedWindowId 标记哪些已脱离） */
  main: TabState[];
  /** 所有浏览器窗口（含 parentTabId 关联到主窗口标签） */
  browsers: {
    windowId: string;
    parentTabId: string | null;
    profileId: string;
    platformName: string | null;
    tabs: BrowserTabState[];
  }[];
}

/** 查询所有窗口的标签树（主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签） */
export async function queryAllTabs(): Promise<AllTabsTree> {
  const api = requireElectron();
  return api.browser.queryAllTabs();
}

/** 聚焦指定浏览器窗口 */
export async function focusBrowserWindow(windowId: string): Promise<boolean> {
  const api = requireElectron();
  return api.browser.focusWindow(windowId);
}

/** 主→渲染：标签音频状态变化（页面开始/停止播放音频）。返回取消监听函数。 */
export function onBrowserTabAudioChanged(
  callback: (payload: { windowId: string; tabId: string; audible: boolean }) => void,
): () => void {
  const api = requireElectron();
  return api.browser.onTabAudioChanged(callback);
}

/* =====================================================================
   书签系统 —— v0.0.9 对应 window.electron.browser.bookmark
   ===================================================================== */

/** 查询书签列表（可选过滤） */
export async function listBookmarks(filter?: BookmarkFilter): Promise<Bookmark[]> {
  const api = requireElectron();
  return api.browser.bookmark.list(filter);
}

/** 新增书签；返回完整 Bookmark */
export async function addBookmark(input: BookmarkInput): Promise<Bookmark> {
  const api = requireElectron();
  return api.browser.bookmark.add(input);
}

/** 更新书签（部分字段）；返回更新后的对象 */
export async function updateBookmark(id: string, patch: BookmarkPatch): Promise<Bookmark | undefined> {
  const api = requireElectron();
  return api.browser.bookmark.update(id, patch);
}

/** 删除书签 */
export async function deleteBookmark(id: string): Promise<void> {
  const api = requireElectron();
  return api.browser.bookmark.delete(id);
}

/** 重排序书签栏（按 ids 顺序依次赋值 sort_order） */
export async function reorderBookmarks(ids: string[]): Promise<void> {
  const api = requireElectron();
  return api.browser.bookmark.reorder(ids);
}
