/* =====================================================================
   pages/BrowserView/hooks/useBrowserInit.ts —— 浏览器窗口初始化与生命周期
   职责：
   - 浏览器标签 store 订阅（唯一订阅点）
   - 会话初始化（windowId/profileId 查询参数 → loadProfiles + init）
   - E1 消费主窗口 AI 应用内累积的链接，转为浏览器窗口标签页
   - P1-3 确保窗口至少有一个非内部标签
   - E2 关闭窗口时将所有网页标签迁移回主窗口
   - E3 根据标签状态同步窗口标题
   - 冻结状态订阅与切换同步
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { useProfileStore } from '../../../store/useProfileStore.js';
import { useTabStore } from '../../../store/useTabStore.js';
import { useFreezeStore } from '../../../store/useFreezeStore.js';
import { consumeAccumulatedLinks, browserTabMigrateBack } from '../../../lib/electron-api/index.js';
import type { Profile } from '../../../lib/electron-api/index.js';
import { getQueryParam, INTERNAL_TAB_SOURCES } from '../constants.js';

export function useBrowserInit() {
  const {
    tabs,
    activeTabId,
    profileId,
    initialized,
    init,
    newTab,
    switchTab,
    navigateTab,
    updateTabNavState,
    bookmarkBarVisible,
    setBookmarkBarVisible,
  } = useBrowserTabStore();

  const profiles = useProfileStore((s) => s.profiles);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const addressBarRef = useRef<HTMLInputElement | null>(null);
  const webviewContainerRef = useRef<HTMLDivElement | null>(null);

  // 初始化
  useEffect(() => {
    const windowId = getQueryParam('windowId') || '';
    const pid = getQueryParam('profileId') || '';
    if (!windowId || !pid) return;

    void (async () => {
      await useProfileStore.getState().loadProfiles();
      await init(windowId, pid);
      const p = useProfileStore.getState().profiles.find((pr) => pr.id === pid) ?? null;
      setProfile(p);
      setReady(true);
      // E1：消费主窗口 AI 应用内累积的链接，转为浏览器窗口的标签页。
      // consume 语义：取出并清空，避免重复消费。累积链接在主窗口拦截 new-window 时
      // 由 helpers.ts 写入（仅主窗口模式，浏览器窗口模式不累积）。
      try {
        const links = await consumeAccumulatedLinks(pid);
        if (links && links.length > 0) {
          const store = useBrowserTabStore.getState();
          for (const link of links) {
            store.newTab(link.url, { source: 'external', kind: 'web' });
            // newTab 不接受 title 参数，创建后立即更新标题为累积时的标题（通常为 URL）。
            // webview 加载页面后 page-title-updated 事件会自动更新为真实标题。
            const newTabId = useBrowserTabStore.getState().activeTabId;
            if (newTabId && link.title) {
              store.updateTabTitle(newTabId, link.title);
            }
          }
          console.log(`[BrowserView] E1 消费 ${links.length} 条累积链接`);
        }
      } catch (e) {
        console.warn('[BrowserView] E1 消费累积链接失败:', e);
      }

      // P1-3：确保窗口至少有一个非内部标签（空白首页标签）
      const store = useBrowserTabStore.getState();
      const hasNonInternal = store.tabs.some((t) => !INTERNAL_TAB_SOURCES.includes(t.source));
      if (!hasNonInternal) {
        store.newTab('', { source: 'initial', kind: 'home' });
      }
    })();
  }, [init]);

  // E3：根据标签状态同步窗口标题（document.title 控制 BrowserWindow 标题栏 + 任务栏文本）
  // - 存在 AI 应用标签（非内部设置/书签管理器）时显示 profile.name
  // - 所有 AI 应用标签关闭后回到默认 'SidekickAI'
  useEffect(() => {
    const hasAppTab = tabs.some(
      (t) => !INTERNAL_TAB_SOURCES.includes(t.source),
    );
    if (hasAppTab && profile) {
      document.title = profile.name;
    } else {
      document.title = 'SidekickAI';
    }
  }, [tabs, profile]);

  // 关闭窗口时，将所有网页标签迁移回主窗口（按 parentTabId 精确恢复）
  useEffect(() => {
    const handleBeforeUnload = () => {
      const store = useBrowserTabStore.getState();
      if (!store.profileId) return;
      // E2：收集所有非内部标签的 finalUrls + parentTabId + originalOrder + source
      // originalOrder：同 parentTabId 内的原始排序，主窗口据此按序插入到父标签右侧
      // source：'settings' 迁移后通知主窗口切换至主页（不作为主窗口主页插入）
      const finalUrls = store.tabs
        .filter((t) => !INTERNAL_TAB_SOURCES.includes(t.source))
        .map((t, idx) => ({
          parentTabId: t.parentTabId,
          url: t.url || '',
          title: t.title || '',
          originalOrder: idx,
          source: t.source,
        }));
      // 同时传当前激活标签的 url/title
      const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
      const isMigratable = activeTab && activeTab.source !== 'settings' && activeTab.source !== 'bookmark-manager' && activeTab.source !== 'history' && activeTab.source !== 'downloads';
      const activeUrl = isMigratable
        ? (activeTab.url || '')
        : (finalUrls[0]?.url ?? '');
      const activeTitle = isMigratable
        ? (activeTab.title || '')
        : (finalUrls[0]?.title ?? '');
      browserTabMigrateBack({
        profileId: store.profileId,
        url: activeUrl,
        title: activeTitle,
        finalUrls,
      });
      // D3: 迁移完成后触发主窗口 AI 输入框聚焦
      useTabStore.getState().triggerFocusAiInput();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 冻结状态订阅 + 切换标签时同步冻结状态
  useEffect(() => {
    const off = useFreezeStore.getState().init();
    return off;
  }, []);
  useEffect(() => {
    if (activeTabId) void useFreezeStore.getState().syncStatus(activeTabId);
  }, [activeTabId]);
  // 窗口回到前台时兜底同步冻结状态（主进程 blur 自动恢复的广播可能丢失）
  useEffect(() => {
    const onFocus = () => {
      if (activeTabId) void useFreezeStore.getState().syncStatus(activeTabId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeTabId]);

  return {
    tabs,
    activeTabId,
    profileId,
    initialized,
    init,
    newTab,
    switchTab,
    navigateTab,
    updateTabNavState,
    bookmarkBarVisible,
    setBookmarkBarVisible,
    profiles,
    ready,
    profile,
    addressBarRef,
    webviewContainerRef,
  };
}
