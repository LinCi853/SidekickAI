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
  newTab: (url?: string, opts?: { source?: BrowserTabState['source']; kind?: 'home' | 'web' }) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  navigateTab: (tabId: string, url: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabFavicon: (tabId: string, favicon: string) => void;
  updateTabLoading: (tabId: string, isLoading: boolean) => void;
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
        : profile?.name || '新标签';
    const newTab: BrowserTabState = {
      id,
      profileId,
      title,
      url: url || profile?.aiPlatformUrl || '',
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
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get();
    const closingTab = tabs.find((t) => t.id === tabId);
    // 推入最近关闭记录（仅网页标签，设置页等内部标签不记录）
    if (closingTab && closingTab.kind === 'web' && closingTab.url && closingTab.source !== 'settings' && closingTab.source !== 'bookmark-manager') {
      useRecentClosedStore.getState().push({
        id: closingTab.id,
        title: closingTab.title || closingTab.url,
        url: closingTab.url,
        favicon: closingTab.favicon,
        closedAt: Date.now(),
      });
    }
    const newTabs = tabs.filter((t) => t.id !== tabId);
    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }
    set({ tabs: newTabs, activeTabId: newActiveId });
    get().persist();
    // 最后一个标签关闭时关闭窗口
    if (newTabs.length === 0) {
      void import('../lib/electron-api').then((api) => api.closeCurrentWindow());
    }
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

  updateTabLoading: (tabId: string, isLoading: boolean) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, isLoading } : t)),
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
