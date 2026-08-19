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
  AccumulatedLink,
  MigratedTabInfo,
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
// E1：累积链接类型 re-export（供 BrowserView 消费累积链接时使用）
export type { AccumulatedLink, MigratedTabInfo };

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

/** 另存为：保存指定 webview 的当前页面（HTMLComplete）到用户指定路径 */
export async function savePageAs(
  webContentsId: number,
  suggestedName?: string,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.savePageAs(webContentsId, suggestedName);
}

/** 另存为：下载指定 URL（链接/图片）到用户指定路径（主进程弹保存对话框） */
export async function downloadAs(
  partition: string,
  url: string,
  suggestedFilename?: string,
): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.downloadAs(partition, url, suggestedFilename);
}

/** 查看网页源代码：按 session partition 抓取原始 HTML 文本（携带登录态 Cookie） */
export async function viewSource(
  partition: string,
  url: string,
): Promise<{ ok: boolean; html?: string; contentType?: string; error?: string }> {
  const api = requireElectron();
  return api.browser.viewSource(partition, url);
}

/** 打印预览：生成当前页面的 PDF 临时文件并返回文件路径 */
export async function printPreview(
  webContentsId: number,
  title?: string,
): Promise<{ ok: boolean; filePath?: string; title?: string; error?: string }> {
  const api = requireElectron();
  return api.browser.printPreview(webContentsId, title);
}

/** 打印预览页「另存为」：把临时 PDF 复制到用户指定路径 */
export async function savePdfAs(
  sourcePath: string,
  suggestedName?: string,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.savePdfAs(sourcePath, suggestedName);
}

/** 删除打印预览临时文件 */
export async function deleteTempPdf(filePath: string): Promise<{ ok: boolean }> {
  const api = requireElectron();
  return api.browser.deleteTempPdf(filePath);
}

/** 网页截图：保存截图 PNG（dataURL）到用户指定路径 */
export async function saveCapture(
  dataUrl: string,
  suggestedName?: string,
): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.saveCapture(dataUrl, suggestedName);
}

/** 云电脑模式：进入/退出（主进程挂起/恢复全局热键、同步全屏） */
export async function setCloudPcMode(enter: boolean): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  if (typeof api.browser.setCloudPcMode !== 'function') {
    // 旧版 preload 未更新（应用未重启 / 未重新构建）
    return { ok: false, error: '主进程接口未更新，请完全退出并重启应用' };
  }
  return api.browser.setCloudPcMode(enter);
}

/** 全局光标屏幕坐标（全屏悬浮退出条的光标探测用） */
export function getCursorPos(): Promise<{ ok: boolean; x: number; y: number }> {
  const api = requireElectron();
  if (typeof api.browser.getCursorPos !== 'function') {
    // 旧版 preload 未更新（应用未重启 / 未重新构建）
    return Promise.resolve({ ok: false, x: 0, y: 0 });
  }
  return api.browser.getCursorPos();
}

/** 主→渲染：云电脑模式状态变化（含主进程兜底退出通知）。返回取消监听函数。 */
export function onCloudPcChanged(callback: (active: boolean) => void): () => void {
  const api = requireElectron();
  return api.browser.onCloudPcChanged(callback);
}

/** 主→渲染：云电脑模式系统级按键路由（Win/Alt+Tab 等，渲染层合成注入 guest）。返回取消监听函数。 */
export function onCloudPcKeys(
  callback: (e: { key: string; down: boolean; alt: boolean; win: boolean }) => void,
): () => void {
  const api = requireElectron();
  return api.browser.onCloudPcKeys(callback);
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

/** 删除单条下载记录（仅删除记录，不删除文件） */
export async function deleteDownload(id: string): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.deleteDownload(id);
}

/** 清空全部下载记录（可选按 windowId 过滤；仅删除记录，不删除文件） */
export async function clearAllDownloads(windowId?: string): Promise<{ ok: boolean; error?: string }> {
  const api = requireElectron();
  return api.browser.clearAllDownloads(windowId);
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

/** 分页查询导航历史（按时间倒序；profileId 省略时跨 Profile 聚合） */
export async function listNavHistory(profileId: string | undefined, page: number, pageSize: number): Promise<NavHistoryEntry[]> {
  const api = requireElectron();
  return api.navHistory.list(profileId, page, pageSize);
}

/** 关键词搜索导航历史（URL / title 模糊匹配；profileId 省略时跨 Profile 聚合） */
export async function searchNavHistory(profileId: string | undefined, keyword: string): Promise<NavHistoryEntry[]> {
  const api = requireElectron();
  return api.navHistory.search(profileId, keyword);
}

/** 删除单条导航历史 */
export async function deleteNavHistory(id: string): Promise<void> {
  const api = requireElectron();
  return api.navHistory.delete(id);
}

/** 清空全部导航历史（可选按 profileId 过滤） */
export async function clearAllNavHistory(profileId?: string): Promise<void> {
  const api = requireElectron();
  return api.navHistory.clearAll(profileId);
}

/** 打开历史记录与下载管理独立窗口（单例） */
export async function openHistoryDownloadWindow(): Promise<void> {
  const api = requireElectron();
  return api.openHistoryDownloadWindow();
}

/** 浏览器窗口关闭时，将当前标签迁移回主窗口 */
export function browserTabMigrateBack(payload: {
  profileId: string;
  url: string;
  title: string;
  /** v0.0.9: 所有标签的最终 URL（按 parentTabId 精确恢复多标签） */
  finalUrls?: MigratedTabInfo[];
}): void {
  const api = requireElectron();
  api.browser.tabMigrateBack(payload);
}

/** 监听浏览器窗口标签迁移回主窗口的事件（主窗口渲染层使用） */
export function onBrowserTabMigrateBack(
  callback: (payload: { profileId: string; url: string; title: string; finalUrls?: MigratedTabInfo[] }) => void,
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

/* =====================================================================
   累积链接 —— E1：AI 应用内新窗口链接累积
   ===================================================================== */

/** 添加一条累积链接（主窗口 AI 应用内拦截的新窗口链接） */
export async function addAccumulatedLink(profileId: string, url: string, title: string): Promise<void> {
  const api = requireElectron();
  return api.browser.accumulatedLinks.add(profileId, url, title);
}

/** 列出指定 Profile 的全部累积链接（按 timestamp 升序） */
export async function listAccumulatedLinks(profileId: string): Promise<AccumulatedLink[]> {
  const api = requireElectron();
  return api.browser.accumulatedLinks.list(profileId);
}

/** 取出并清空指定 Profile 的全部累积链接（窗口初始化时消费） */
export async function consumeAccumulatedLinks(profileId: string): Promise<AccumulatedLink[]> {
  const api = requireElectron();
  return api.browser.accumulatedLinks.consume(profileId);
}

/** 清空指定 Profile 的全部累积链接 */
export async function clearAccumulatedLinks(profileId: string): Promise<void> {
  const api = requireElectron();
  return api.browser.accumulatedLinks.clear(profileId);
}
