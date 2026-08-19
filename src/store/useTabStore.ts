/* =====================================================================
   store/useTabStore.ts —— 标签与窗口状态管理（多标签架构）
   维护当前窗口的标签列表、激活标签、窗口控制态（置顶/最大化）。
   状态变更时自动持久化到主进程（windowState.save IPC）。
   ===================================================================== */

import { create } from 'zustand';
import type { TabState, WindowStateData, Profile } from '../lib/electron-api';
import {
  getWindowState,
  saveWindowState,
  getWindowBounds,
  setupSession,
  updateTabTitle,
  updateTabUrl,
  updateTabHomeUrl,
  detachTab,
  pinCurrentWindow,
  maximizeToggleWindow,
  onMaximizeToggled,
  onPinToggled,
} from '../lib/electron-api';
import { useFreezeStore } from './useFreezeStore';

export interface TabStoreState {
  /** 当前窗口 id（'main' 或 UUID） */
  windowId: string;
  /** 标签列表 */
  tabs: TabState[];
  /** 激活标签 id */
  activeTabId: string | null;
  /** 是否最大化 */
  isMaximized: boolean;
  /** 是否置顶 */
  alwaysOnTop: boolean;
  /** 底栏是否展开 */
  bottomBarExpanded: boolean;
  /** 底栏展开时高度（px） */
  bottomBarHeight: number;
  /** 是否已初始化 */
  initialized: boolean;
  /** 最大化切换锁（防止快速重复触发） */
  _maximizingLock: boolean;
  /** 置顶切换锁（防止快速重复触发） */
  _pinLock: boolean;
  /** IPC 监听器是否已设置（避免重复注册） */
  _ipcListenersSetUp: boolean;
  /** AI 输入框聚焦触发器（每次自增触发 useEffect） */
  focusAiInputTrigger: number;
  /** 触发 AI 输入框聚焦 */
  triggerFocusAiInput: () => void;

  /** 初始化：从主进程加载持久化状态 */
  init: (windowId: string) => Promise<void>;
  /** 新增标签（打开 AI 平台，可选自定义 URL 和标题） */
  addTab: (profile: Profile, opts?: { url?: string; title?: string }) => Promise<void>;
  /** 关闭标签 */
  closeTab: (tabId: string) => Promise<void>;
  /** 切换激活标签 */
  setActiveTab: (tabId: string) => void;
  /** 更新标签标题 */
  renameTab: (tabId: string, title: string) => Promise<void>;
  /** 更新标签 URL */
  updateTabUrl: (tabId: string, url: string) => Promise<void>;
  /** 更新标签首页地址 */
  updateTabHomeUrl: (tabId: string, homeUrl: string) => Promise<void>;
  /** 移动标签排序 */
  moveTab: (dragId: string, hoverId: string) => void;
  /**
   * E2：将一组标签插入到指定父标签右侧（依次追加）。
   * 用于浏览器窗口关闭后，迁移回主窗口的标签按 parentTabId 分组、组内按 originalOrder
   * 排序后插入到父标签右侧，还原用户在浏览器窗口内的标签顺序。
   * @param parentTabId  主窗口内的父标签 id
   * @param tabsToInsert 待插入的 TabState 数组（已按 originalOrder 排序）
   */
  insertTabAfterParent: (parentTabId: string, tabsToInsert: TabState[]) => void;
  /** 脱离标签为独立窗口 */
  detachTab: (tabId: string) => Promise<void>;
  /** 设置置顶 */
  setAlwaysOnTop: (onTop: boolean) => void;
  /** 切换置顶（带锁，防止快速重复触发） */
  toggleAlwaysOnTop: () => void;
  /** 设置最大化态 */
  setMaximized: (maximized: boolean) => void;
  /** 切换最大化（带锁，防止快速重复触发） */
  toggleMaximize: () => void;
  /** 切换底栏展开 */
  toggleBottomBar: () => void;
  /** 直接设置底栏展开状态（窗口隐藏时显式收起，非 toggle） */
  setBottomBarExpanded: (expanded: boolean) => void;
  /** 设置底栏高度（拖拽调整） */
  setBottomBarHeight: (height: number) => void;
  /** 获取当前激活标签 */
  getActiveTab: () => TabState | null;
  /** 标记/取消标记 tab 为窄屏自动移动端切换状态 */
  setTabAutoMobile: (tabId: string, autoMobile: boolean, originalDevicePreset?: string) => void;
  /** 已脱离到浏览器窗口的 Profile id 集合 */
  detachedProfiles: Set<string>;
  /** 添加脱离 Profile */
  addDetachedProfile: (profileId: string) => void;
  /** 移除脱离 Profile（恢复） */
  removeDetachedProfile: (profileId: string) => void;
  /** 防抖持久化当前状态到主进程 */
  persist: () => void;
}

/** 默认底栏展开高度 */
const DEFAULT_BOTTOM_BAR_HEIGHT = 220;

/** 防抖持久化 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useTabStore = create<TabStoreState>((set, get) => ({
  windowId: 'main',
  tabs: [],
  activeTabId: null,
  isMaximized: false,
  alwaysOnTop: false,
  bottomBarExpanded: false,
  bottomBarHeight: DEFAULT_BOTTOM_BAR_HEIGHT,
  initialized: false,
  _maximizingLock: false,
  _pinLock: false,
  _ipcListenersSetUp: false,
  focusAiInputTrigger: 0,
  detachedProfiles: new Set<string>(),

  triggerFocusAiInput: () => set((state) => ({ focusAiInputTrigger: state.focusAiInputTrigger + 1 })),

  init: async (windowId) => {
    console.log('[useTabStore.init] 开始, windowId:', windowId);
    try {
      const state = await getWindowState(windowId);
      console.log('[useTabStore.init] getWindowState 返回:', state ? `tabs=${state.tabs.length}` : 'null');
      if (state) {
        // 为恢复的每个 tab 预准备 session（UA + Client Hints）
        // 避免持久化状态恢复后 webview 直接使用默认 UA 加载
        for (const tab of state.tabs) {
          try {
            await setupSession(tab.profileId);
          } catch (e) {
            console.error('[useTabStore.init] 恢复 tab 时 setupSession 失败:', tab.profileId, e);
          }
        }
        // v0.0.9: 启动时清除所有 detachedProfiles（启动时不可能有浏览器窗口还开着）
        // 同时清除 TabState 的 detachedWindowId，恢复所有标签可见性
        const cleanedTabs = state.tabs.map((t) => ({ ...t, detachedWindowId: null as string | null }));
        set({
          windowId,
          tabs: cleanedTabs,
          activeTabId: state.activeTabId,
          isMaximized: state.isMaximized,
          alwaysOnTop: state.alwaysOnTop,
          bottomBarExpanded: state.bottomBarExpanded,
          bottomBarHeight: state.bottomBarHeight ?? DEFAULT_BOTTOM_BAR_HEIGHT,
          detachedProfiles: new Set<string>(), // 清空：启动时无浏览器窗口
          initialized: true,
        });
        console.log('[useTabStore.init] 从持久化恢复，tabs:', cleanedTabs.map(t => t.title));
        // 持久化清理后的状态（清除遗留的 detachedProfiles）
        get().persist();
      } else {
        set({ windowId, initialized: true });
        console.log('[useTabStore.init] 无持久化状态，使用默认（空 tabs）');
      }
    } catch (e) {
      console.error('[useTabStore.init] 初始化失败:', e);
      set({ windowId, initialized: true });
    }

    // 设置 IPC 监听器（仅一次）：主进程 webview 快捷键兜底触发后同步状态
    if (!get()._ipcListenersSetUp) {
      set({ _ipcListenersSetUp: true });
      try {
        onMaximizeToggled((isMax) => {
          set({ isMaximized: isMax });
          get().persist();
        });
        onPinToggled((onTop) => {
          set({ alwaysOnTop: onTop });
          get().persist();
        });
      } catch (e) {
        console.error('[useTabStore.init] 设置 IPC 监听器失败:', e);
      }
    }
  },

  addTab: async (profile, opts?) => {
    const url = opts?.url;
    const { tabs, detachedProfiles } = get();
    // v0.0.9: 如果该 profile 之前被标记为脱离但浏览器窗口已关闭，清除脱离标记
    if (detachedProfiles.has(profile.id)) {
      get().removeDetachedProfile(profile.id);
    }
    // 已存在同 profileId 的标签则激活（不传 url 时按 profile 匹配，支持首页和浏览中页面）
    const existing = tabs.find((t) => t.profileId === profile.id);
    if (existing && !url) {
      set({ activeTabId: existing.id });
      get().persist();
      return;
    }
    // 传 url 时：如果已有同 profileId + 同 url 的标签则激活，否则新建
    if (existing && url && existing.url === url) {
      set({ activeTabId: existing.id });
      get().persist();
      return;
    }
    const tab: TabState = {
      id: crypto.randomUUID(),
      profileId: profile.id,
      // 优先使用显式传入的 title，其次沿用同 profile 已有 tab 的持久化 title，最后回退 profile.name
      title: opts?.title || existing?.title || profile.name,
      order: tabs.length,
      url,
    };
    // 为 webview 准备 session（UA + Client Hints）
    try {
      await setupSession(profile.id);
    } catch (e) {
      console.error('[useTabStore.addTab] setupSession 失败:', e);
    }
    set({
      tabs: [...tabs, tab],
      activeTabId: tab.id,
    });
    get().persist();
  },

  closeTab: async (tabId) => {
    const detached = await useFreezeStore.getState().doDetach(tabId);
    if (!detached) {
      console.warn('[useTabStore] 冻结调试器清理失败，取消关闭标签', tabId);
      return;
    }
    set((current) => {
      const newTabs = current.tabs
        .filter((tab) => tab.id !== tabId)
        .map((tab, index) => ({ ...tab, order: index }));
      return {
        tabs: newTabs,
        activeTabId: current.activeTabId === tabId ? newTabs[0]?.id ?? null : current.activeTabId,
      };
    });
    get().persist();
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
    get().persist();
  },

  renameTab: async (tabId, title) => {
    const { windowId } = get();
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    }));
    try {
      await updateTabTitle(windowId, tabId, title);
    } catch (e) {
      console.error('[useTabStore] 标题持久化失败:', e);
    }
    get().persist();
  },

  updateTabUrl: async (tabId, url) => {
    const { windowId } = get();
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, url } : t)),
    }));
    try {
      await updateTabUrl(windowId, tabId, url);
    } catch (e) {
      console.error('[useTabStore] URL 持久化失败:', e);
    }
    get().persist();
  },

  updateTabHomeUrl: async (tabId, homeUrl) => {
    const { windowId } = get();
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, homeUrl } : t)),
    }));
    try {
      await updateTabHomeUrl(windowId, tabId, homeUrl);
    } catch (e) {
      console.error('[useTabStore] 首页地址持久化失败:', e);
    }
    get().persist();
  },

  moveTab: (dragId, hoverId) => {
    const { tabs } = get();
    const dragIndex = tabs.findIndex((t) => t.id === dragId);
    const hoverIndex = tabs.findIndex((t) => t.id === hoverId);
    if (dragIndex === -1 || hoverIndex === -1 || dragIndex === hoverIndex) return;
    const newTabs = [...tabs];
    const [dragged] = newTabs.splice(dragIndex, 1);
    newTabs.splice(hoverIndex, 0, dragged);
    const reorderedTabs = newTabs.map((t, i) => ({ ...t, order: i }));
    set({ tabs: reorderedTabs });
    get().persist();
  },

  insertTabAfterParent: (parentTabId, tabsToInsert) => {
    if (tabsToInsert.length === 0) return;
    set((state) => {
      const parentIdx = state.tabs.findIndex((t) => t.id === parentTabId);
      if (parentIdx === -1) return state;
      const newTabs = [...state.tabs];
      // 在父标签右侧依次追加插入（保持 tabsToInsert 顺序）
      newTabs.splice(parentIdx + 1, 0, ...tabsToInsert);
      // 重新分配 order，保证连续
      const reorderedTabs = newTabs.map((t, i) => ({ ...t, order: i }));
      return { tabs: reorderedTabs };
    });
    get().persist();
  },

  detachTab: async (tabId) => {
    try {
      await detachTab(tabId);
      // 复制语义：源窗口保留 tab（webview 不卸载，保留页面状态）
      // 新窗口由主进程创建并加载同 partition + 同 URL
      // 仅触发持久化以保持源窗口 state 一致（主进程不再从源 state 移除）
      get().persist();
    } catch (e) {
      console.error('[useTabStore] 脱离标签失败:', e);
    }
  },

  setAlwaysOnTop: (onTop) => {
    // 乐观更新 UI 立即响应，IPC 失败时回滚
    const previous = get().alwaysOnTop;
    set({ alwaysOnTop: onTop });
    // 调用 IPC 实际置顶当前窗口（主进程会同步持久化）
    pinCurrentWindow(onTop)
      .then((actual) => {
        // 同步实际结果：若主进程拒绝了（返回 undefined/false）则回滚
        if (typeof actual === 'boolean' && actual !== onTop) {
          set({ alwaysOnTop: actual });
        }
        get().persist();
      })
      .catch((e) => {
        console.error('[useTabStore] 置顶失败，回滚:', e);
        set({ alwaysOnTop: previous });
      });
  },

  setMaximized: (maximized) => {
    set({ isMaximized: maximized });
  },

  // 切换最大化（带锁，防止快速重复触发）
  toggleMaximize: () => {
    const state = get();
    if (state._maximizingLock) return;
    set({ _maximizingLock: true });
    maximizeToggleWindow()
      .then((maximized) => {
        set({ isMaximized: !!maximized, _maximizingLock: false });
        get().persist();
      })
      .catch((e) => { console.warn('[tab-store] 最大化失败:', e); set({ _maximizingLock: false }); });
  },

  // 切换置顶（带锁，防止快速重复触发；基于当前实际状态切换）
  toggleAlwaysOnTop: () => {
    const state = get();
    if (state._pinLock) return;
    set({ _pinLock: true });
    const target = !state.alwaysOnTop;
    set({ alwaysOnTop: target });
    pinCurrentWindow(target)
      .then((actual) => {
        if (typeof actual === 'boolean') {
          set({ alwaysOnTop: actual });
        }
        set({ _pinLock: false });
        get().persist();
      })
      .catch((e) => {
        console.error('[useTabStore] 切换置顶失败:', e);
        set({ alwaysOnTop: !target, _pinLock: false });
      });
  },

  toggleBottomBar: () => {
    set((s) => ({ bottomBarExpanded: !s.bottomBarExpanded }));
    get().persist();
  },

  setBottomBarExpanded: (expanded) => {
    set({ bottomBarExpanded: expanded });
    get().persist();
  },

  setBottomBarHeight: (height) => {
    set({ bottomBarHeight: Math.round(height) });
    get().persist();
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get();
    return tabs.find((t) => t.id === activeTabId) ?? null;
  },

  setTabAutoMobile: (tabId, autoMobile, originalDevicePreset) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              autoMobile,
              originalDevicePreset: autoMobile ? originalDevicePreset : undefined,
            }
          : t,
      ),
    }));
    get().persist();
  },

  addDetachedProfile: (profileId) => {
    set((s) => {
      const next = new Set(s.detachedProfiles);
      next.add(profileId);
      return { detachedProfiles: next };
    });
    get().persist();
  },

  removeDetachedProfile: (profileId) => {
    set((s) => {
      const next = new Set(s.detachedProfiles);
      next.delete(profileId);
      return { detachedProfiles: next };
    });
    get().persist();
  },

  persist: () => {
    const { windowId, tabs, activeTabId, isMaximized, alwaysOnTop, bottomBarExpanded, bottomBarHeight, detachedProfiles } = get();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const bounds = await getWindowBounds();
        const state: WindowStateData = {
          windowId,
          bounds,
          isMaximized,
          alwaysOnTop,
          activeTabId,
          tabs,
          bottomBarExpanded,
          bottomBarHeight,
          detachedProfiles: Array.from(detachedProfiles),
        };
        await saveWindowState(windowId, state);
      } catch (e) {
        console.error('[useTabStore] 持久化失败:', e);
      }
    }, 400);
  },
}));
