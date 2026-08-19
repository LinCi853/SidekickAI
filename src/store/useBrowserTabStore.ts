/* =====================================================================
   store/useBrowserTabStore.ts —— 浏览器窗口标签状态管理
   多标签浏览器窗口的标签列表、激活标签、窗口控制态。
   状态变更时自动持久化到主进程（browserWindowStore）。
   v0.0.9：新增 pin/mute/audible/sitePermissions/recentClosed/queryChildTabs
   ===================================================================== */

import { create } from 'zustand';
import type { BrowserTabState, BrowserWindowState } from '../lib/electron-api';
import {
  getBrowserState,
  saveBrowserState,
  onMaximizeToggled,
  onPinToggled,
  onToggleFullscreen,
  queryAllTabs,
  type AllTabsTree,
} from '../lib/electron-api';
import { useProfileStore } from './useProfileStore';
import { useRecentClosedStore } from '../pages/BrowserView/RecentClosedStore';
import { useFreezeStore } from './useFreezeStore';

export interface BrowserTabStoreState {
  windowId: string;
  profileId: string;
  tabs: BrowserTabState[];
  activeTabId: string | null;
  isMaximized: boolean;
  alwaysOnTop: boolean;
  isFullscreen: boolean;
  /** 书签栏是否显示（默认 true） */
  bookmarkBarVisible: boolean;
  initialized: boolean;

  init: (windowId: string, profileId: string) => Promise<void>;
  newTab: (url?: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => string;
  /** 打开书签/链接：已存在同 URL 标签则切换聚焦，否则新建（书签点击的标准语义） */
  openTabOrFocus: (url: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => string;
  closeTab: (tabId: string) => Promise<void>;
  switchTab: (tabId: string) => void;
  navigateTab: (tabId: string, url: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabFavicon: (tabId: string, favicon: string) => void;
  /** 更新网站主题色（从 meta[name="theme-color"] 提取，用于 favicon 占位） */
  updateTabThemeColor: (tabId: string, themeColor: string) => void;
  updateTabLoading: (tabId: string, isLoading: boolean) => void;
  /** 更新标签加载进度估算（0-100，0 表示隐藏进度条） */
  updateTabLoadingProgress: (tabId: string, progress: number) => void;
  /** 更新标签加载状态文本（如 "正在连接..." / "等待响应..." / "已完成"） */
  updateTabLoadingStatus: (tabId: string, status: string) => void;
  updateTabNavState: (tabId: string, canGoBack: boolean, canGoForward: boolean) => void;
  moveTab: (dragId: string, hoverId: string) => void;
  /** 切换标签固定状态（固定标签排左侧、占用最小宽度、不显示关闭按钮） */
  togglePin: (tabId: string) => void;
  /** 切换标签静音（store 仅记录状态，webview setAudioMuted 由组件层负责） */
  setMuted: (tabId: string, muted: boolean) => void;
  /** 更新标签 audible 状态（webview media 事件驱动） */
  updateAudible: (tabId: string, audible: boolean) => void;
  /** 更新标签站点权限（轻量：mute/blockDownload/blockNotification） */
  updateSitePermissions: (tabId: string, permissions: Partial<NonNullable<BrowserTabState['sitePermissions']>>) => void;
  /** 查询跨窗口标签树（主窗口 A 标签 ↔ 浏览器窗口 A1/A2/A3 子标签） */
  queryChildTabs: () => Promise<AllTabsTree>;
  /** 设置书签栏显示/隐藏 */
  setBookmarkBarVisible: (visible: boolean) => void;
  setMaximized: (maximized: boolean) => void;
  setAlwaysOnTop: (onTop: boolean) => void;
  setFullscreen: (fullscreen: boolean) => void;
  persist: () => void;
}

/** 防抖持久化 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useBrowserTabStore = create<BrowserTabStoreState>((set, get) => ({
  windowId: '',
  profileId: '',
  tabs: [],
  activeTabId: null,
  isMaximized: true,
  alwaysOnTop: false,
  isFullscreen: false,
  bookmarkBarVisible: true,
  initialized: false,

  init: async (windowId: string, profileId: string) => {
    const state = await getBrowserState(windowId);
    if (state) {
      set({
        windowId,
        profileId,
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        isMaximized: state.isMaximized,
        alwaysOnTop: state.alwaysOnTop,
        isFullscreen: state.isFullscreen,
        bookmarkBarVisible: state.bookmarkBarVisible ?? true,
        initialized: true,
      });
    } else {
      set({ windowId, profileId, initialized: true });
    }

    // 监听主进程推送的窗口状态变化
    onMaximizeToggled((isMax: boolean) => set({ isMaximized: isMax }));
    onPinToggled((pinned: boolean) => set({ alwaysOnTop: pinned }));
    onToggleFullscreen(() => {
      set((s) => ({ isFullscreen: !s.isFullscreen }));
    });
  },

  newTab: (url?: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => {
    const { profileId, tabs } = get();
    const id = crypto.randomUUID();
    const profile = useProfileStore.getState().profiles.find((p) => p.id === profileId);
    // v0.0.9: 内部标签页使用正确名称，不显示 AI 应用名
    const source = opts?.source || 'new';
    const title = source === 'settings'
      ? 'SidekickAI 设置'
      : source === 'bookmark-manager'
        ? '书签管理器'
        : source === 'history'
          ? '导航历史'
          : source === 'downloads'
            ? '下载管理'
            : profile?.name || '新标签';
    const newTab: BrowserTabState = {
      id,
      profileId,
      title,
      url: url || profile?.browserHomePage || profile?.aiPlatformUrl || '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      order: tabs.length,
      source,
      kind: opts?.kind || 'web',
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
    }));
    get().persist();
    return id;
  },

  openTabOrFocus: (url, opts) => {
    const internal = ['settings', 'bookmark-manager', 'history', 'downloads', 'view-source', 'print-preview'];
    const existing = get().tabs.find((t) => t.url === url && !internal.includes(t.source));
    if (existing) {
      set({ activeTabId: existing.id });
      get().persist();
      return existing.id;
    }
    return get().newTab(url, opts);
  },

  closeTab: async (tabId: string) => {
    const initial = get();
    if (!initial.tabs.some((tab) => tab.id === tabId)) return;
    const detached = await useFreezeStore.getState().doDetach(tabId);
    if (!detached) {
      console.warn('[useBrowserTabStore] 冻结调试器清理失败，取消关闭标签', tabId);
      return;
    }
    const internalSources = ['settings', 'bookmark-manager', 'history', 'downloads', 'view-source', 'print-preview'];
    let closedTab: BrowserTabState | undefined;
    let wasInternal = false;
    set((current) => {
      const target = current.tabs.find((tab) => tab.id === tabId);
      if (!target) return current;
      closedTab = target;
      wasInternal = internalSources.includes(target.source);
      const nonInternalTabs = current.tabs.filter((tab) => !internalSources.includes(tab.source));
      if (!wasInternal && nonInternalTabs.length === 1 && nonInternalTabs[0].id === tabId) {
        const profile = useProfileStore.getState().profiles.find((p) => p.id === current.profileId);
        const blankTab: BrowserTabState = {
          ...target,
          source: 'initial',
          url: profile?.browserHomePage || '',
          title: profile?.name || '新标签',
          kind: 'home',
          isLoading: false,
          loadingProgress: 0,
          loadingStatus: undefined,
          canGoBack: false,
          canGoForward: false,
          favicon: undefined,
        };
        return { tabs: current.tabs.map((tab) => (tab.id === tabId ? blankTab : tab)), activeTabId: tabId };
      }
      const newTabs = current.tabs.filter((tab) => tab.id !== tabId);
      return {
        tabs: newTabs,
        activeTabId: current.activeTabId === tabId ? newTabs[newTabs.length - 1]?.id ?? null : current.activeTabId,
      };
    });
    if (!closedTab) return;
    if (closedTab.kind === 'web' && closedTab.url && !wasInternal) {
      useRecentClosedStore.getState().push({
        id: closedTab.id,
        title: closedTab.title || closedTab.url,
        url: closedTab.url,
        favicon: closedTab.favicon,
        closedAt: Date.now(),
      });
    }
    get().persist();
  },

  switchTab: (tabId: string) => {
    set({ activeTabId: tabId });
    get().persist();
  },

  navigateTab: (tabId: string, url: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, url } : t)),
    }));
    get().persist();
  },

  updateTabTitle: (tabId: string, title: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    }));
    get().persist();
  },

  updateTabFavicon: (tabId: string, favicon: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, favicon } : t)),
    }));
    // favicon 变化不触发持久化（高频且非关键）
  },

  updateTabThemeColor: (tabId: string, themeColor: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, themeColor } : t)),
    }));
    // themeColor 变化不触发持久化（非关键数据）
  },

  updateTabLoading: (tabId: string, isLoading: boolean) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, isLoading } : t)),
    }));
  },

  updateTabLoadingProgress: (tabId: string, progress: number) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, loadingProgress: progress } : t,
      ),
    }));
  },

  updateTabLoadingStatus: (tabId: string, status: string) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, loadingStatus: status } : t,
      ),
    }));
  },

  updateTabNavState: (tabId: string, canGoBack: boolean, canGoForward: boolean) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, canGoBack, canGoForward } : t,
      ),
    }));
  },

  moveTab: (dragId: string, hoverId: string) => {
    const { tabs } = get();
    const dragIdx = tabs.findIndex((t) => t.id === dragId);
    const hoverIdx = tabs.findIndex((t) => t.id === hoverId);
    if (dragIdx === -1 || hoverIdx === -1 || dragIdx === hoverIdx) return;
    const newTabs = [...tabs];
    const [removed] = newTabs.splice(dragIdx, 1);
    newTabs.splice(hoverIdx, 0, removed);
    // 固定标签始终排在普通标签左侧
    const sorted = newTabs.map((t, i) => ({ ...t, order: i }))
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.order - b.order;
      })
      .map((t, i) => ({ ...t, order: i }));
    set({ tabs: sorted });
    get().persist();
  },

  togglePin: (tabId: string) => {
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.id === tabId ? { ...t, pinned: !t.pinned } : t,
      );
      // 固定标签排左侧
      const sorted = [...tabs].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.order - b.order;
      }).map((t, i) => ({ ...t, order: i }));
      return { tabs: sorted };
    });
    get().persist();
  },

  setMuted: (tabId: string, muted: boolean) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, muted } : t)),
    }));
    get().persist();
  },

  updateAudible: (tabId: string, audible: boolean) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, audible } : t)),
    }));
    // audible 变化不触发持久化（高频且衍生状态）
  },

  updateSitePermissions: (tabId, permissions) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, sitePermissions: { ...t.sitePermissions, ...permissions } }
          : t,
      ),
    }));
    get().persist();
  },

  queryChildTabs: async () => {
    return queryAllTabs();
  },

  setBookmarkBarVisible: (visible: boolean) => {
    set({ bookmarkBarVisible: visible });
    get().persist();
  },

  setMaximized: (maximized: boolean) => {
    set({ isMaximized: maximized });
  },

  setAlwaysOnTop: (onTop: boolean) => {
    set({ alwaysOnTop: onTop });
  },

  setFullscreen: (fullscreen: boolean) => {
    set({ isFullscreen: fullscreen });
  },

  persist: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { windowId, profileId, tabs, activeTabId, isMaximized, alwaysOnTop, isFullscreen, bookmarkBarVisible } = get();
      if (!windowId) return;
      const state: BrowserWindowState = {
        windowId,
        profileId,
        bounds: { width: 0, height: 0 },
        isMaximized,
        isFullscreen,
        alwaysOnTop,
        activeTabId,
        tabs,
        bookmarkBarVisible,
      };
      void saveBrowserState(windowId, state);
    }, 400);
  },
}));
