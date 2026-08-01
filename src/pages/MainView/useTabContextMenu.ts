/* =====================================================================
   pages/MainView/useTabContextMenu.ts —— 标签右键菜单状态与处理逻辑
   抽离自 index.tsx：菜单显隐 / URL 编辑 / 刷新 / 清除数据 / 关闭标签组 / 设为首页
   所有状态留在 hook 内，index.tsx 通过返回值消费。
   ===================================================================== */

import { useCallback, useRef, useState } from 'react';
import type { Profile, TabState } from '../../lib/electron-api';
import type { WebviewElement } from '../../lib/webview';
import { safeReloadWebview, safeLoadURLWebview, sanitizeUrl } from '../../lib/webview';
import { openAiAppEditor, saveWhiteboardImage, pushImageToWhiteboard } from '../../lib/electron-api';

export interface TabContextMenuParams {
  tabs: TabState[];
  getProfile: (profileId: string) => Profile | null;
  closeTab: (tabId: string) => void;
  updateTabUrl: (tabId: string, url: string) => void;
  updateTabHomeUrl: (tabId: string, url: string) => void;
  /** 查询指定标签的 webview 是否 dom-ready（用于刷新时判断走 reload 还是 loadURL 恢复） */
  isTabDomReady?: (tabId: string) => boolean;
}

export function useTabContextMenu(params: TabContextMenuParams) {
  const { tabs, getProfile, closeTab, updateTabUrl, updateTabHomeUrl, isTabDomReady } = params;

  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const [editingTabUrl, setEditingTabUrl] = useState(false);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenuTabId(null);
    setContextMenuPosition(null);
    setEditingTabUrl(false);
  }, []);

  // 刷新指定标签
  const refreshTab = useCallback((tabId: string) => {
    const webview = document.querySelector(`webview[data-tab-id="${tabId}"]`) as WebviewElement | null;
    if (!webview) return;
    const tab = tabs.find((t) => t.id === tabId);
    const profile = tab ? getProfile(tab.profileId) : null;
    const fallbackUrl = tab?.url || profile?.aiPlatformUrl || '';
    const domReady = isTabDomReady ? isTabDomReady(tabId) : true;
    safeReloadWebview(webview, fallbackUrl, domReady);
  }, [tabs, getProfile, isTabDomReady]);

  // 清除标签数据（缓存 + localStorage + sessionStorage + cookie）
  const clearTabData = useCallback(async (tabId: string) => {
    const webview = document.querySelector(`webview[data-tab-id="${tabId}"]`) as WebviewElement | null;
    if (!webview) return;
    const tab = tabs.find((t) => t.id === tabId);
    const profile = tab ? getProfile(tab.profileId) : null;
    const fallbackUrl = tab?.url || profile?.aiPlatformUrl || '';
    const domReady = isTabDomReady ? isTabDomReady(tabId) : true;
    try {
      const ses = (webview as any).session;
      if (ses) {
        await ses.clearCache();
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb'],
        });
      }
      safeReloadWebview(webview, fallbackUrl, domReady);
    } catch (e) {
      console.warn('[MainView] 清除标签数据失败:', e);
      // 降级：执行 JS 清理
      try {
        await webview.executeJavaScript(`
          localStorage.clear();
          sessionStorage.clear();
          document.cookie.split(';').forEach(c => {
            document.cookie = c.replace(/^ +/, '').replace(/=.*/, '=;expires=' + new Date().toUTCString() + ';path=/');
          });
          location.reload();
        `);
      } catch {
        safeReloadWebview(webview, fallbackUrl, domReady);
      }
    }
  }, [tabs, getProfile, isTabDomReady]);

  // 关闭其他标签
  const closeOtherTabs = useCallback((tabId: string) => {
    const others = tabs.filter((t) => t.id !== tabId);
    others.forEach((t) => void closeTab(t.id));
  }, [tabs, closeTab]);

  // 关闭右侧标签
  const closeTabsToRight = useCallback((tabId: string) => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const rightTabs = tabs.slice(idx + 1);
    rightTabs.forEach((t) => void closeTab(t.id));
  }, [tabs, closeTab]);

  // 设为 AI 首页（仅修改当前标签的首页地址，不影响全局 profile）
  const setAsAIHome = useCallback(async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const profile = getProfile(tab.profileId);
    if (!profile) return;
    const currentUrl = tab.url || profile.aiPlatformUrl;
    if (!currentUrl) return;
    try {
      await updateTabHomeUrl(tabId, currentUrl);
    } catch (e) {
      console.error('[MainView] 设为AI首页失败:', e);
    }
  }, [tabs, getProfile, updateTabHomeUrl]);

  // 配置此 AI 应用：打开 AI 应用编辑器（按 profileId 精确定位，支持同一平台多实例）
  const configureApp = useCallback((tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const profile = getProfile(tab.profileId);
    if (!profile?.isAIPlatform) return;
    void openAiAppEditor({ profileId: profile.id, mode: 'edit' });
  }, [tabs, getProfile]);

  // 需求 12：截图当前 webview 页面到白板（v3：保存图片 → 推送到进阶面板白板 → Excalidraw image 元素）
  const screenshotToWhiteboard = useCallback(async (tabId: string) => {
    const webview = document.querySelector(`webview[data-tab-id="${tabId}"]`) as WebviewElement | null;
    if (!webview) return;
    const tab = tabs.find((t) => t.id === tabId);
    const profile = tab ? getProfile(tab.profileId) : null;
    try {
      const image = await webview.capturePage();
      const dataURL = image.toDataURL();
      // 1. 保存 dataURL 到磁盘 → whiteboard-asset:// 路径
      const assetUrl = await saveWhiteboardImage(dataURL);
      // 2. 推送到白板：主进程打开进阶面板 + 切白板 tab + 转发载荷
      await pushImageToWhiteboard({
        assetUrl,
        sourceUrl: tab?.url,
        platform: profile?.name,
      });
    } catch (e) {
      console.error('[MainView] 截图到白板失败:', e);
    }
  }, [tabs, getProfile]);

  // 右键菜单打开
  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    const tab = tabs.find((t) => t.id === tabId);
    const profile = tab ? getProfile(tab.profileId) : null;
    const currentUrl = tab?.url || profile?.aiPlatformUrl || '';
    setUrlDraft(currentUrl);
    setEditingTabUrl(false);
    setContextMenuTabId(tabId);
    // 菜单大约高度：380px
    const menuHeight = 380;
    const menuWidth = 240;
    const y = Math.min(e.clientY, window.innerHeight - menuHeight);
    const x = Math.min(e.clientX, window.innerWidth - menuWidth);
    setContextMenuPosition({ x, y });
  }, [tabs, getProfile]);

  // 提交修改 URL
  const commitTabUrl = useCallback(() => {
    if (!contextMenuTabId) {
      closeContextMenu();
      return;
    }
    const trimmed = sanitizeUrl(urlDraft);
    const tab = tabs.find((t) => t.id === contextMenuTabId);
    if (tab && trimmed && trimmed !== (tab.url || '')) {
      void updateTabUrl(contextMenuTabId, trimmed);
      const webview = document.querySelector(`webview[data-tab-id="${contextMenuTabId}"]`) as WebviewElement | null;
      if (webview) safeLoadURLWebview(webview, trimmed);
    }
    closeContextMenu();
  }, [contextMenuTabId, urlDraft, tabs, updateTabUrl, closeContextMenu]);

  // 右键菜单"回到首页"所需：当前标签 profile 的 AI 平台 URL
  const contextMenuTab = contextMenuTabId ? tabs.find((t) => t.id === contextMenuTabId) ?? null : null;
  const contextMenuHomeUrl = contextMenuTab ? (getProfile(contextMenuTab.profileId)?.aiPlatformUrl ?? '') : '';
  const contextMenuIsAiPlatform = contextMenuTab
    ? (getProfile(contextMenuTab.profileId)?.isAIPlatform ?? false)
    : false;

  return {
    // 状态
    contextMenuTabId,
    contextMenuPosition,
    urlDraft,
    editingTabUrl,
    urlInputRef,
    // 派生
    contextMenuHomeUrl,
    contextMenuIsAiPlatform,
    // 处理函数
    closeContextMenu,
    refreshTab,
    clearTabData,
    closeOtherTabs,
    closeTabsToRight,
    setAsAIHome,
    configureApp,
    screenshotToWhiteboard,
    handleTabContextMenu,
    commitTabUrl,
    setUrlDraft,
    setEditingTabUrl,
  };
}
