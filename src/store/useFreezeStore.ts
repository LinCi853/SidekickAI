/* =====================================================================
   store/useFreezeStore.ts —— 页面冻结状态管理（防撤回保险）
   按 tabId 维护冻结状态，供 UI 显示指示器 + 控制条。
   ===================================================================== */

import { create } from 'zustand';
import {
  freezeTab,
  resumeFreeze,
  detachFreeze,
  getFreezeStatus,
  onFreezeStateChanged,
  onFreezeSyncRect,
  reportFreezeRect,
  getWebviewRect,
  type FreezeState,
} from '../lib/electron-api';

interface FreezeStore {
  /** tabId → 冻结状态 */
  states: Record<string, FreezeState>;
  /** 冻结时抓取的快照信息（用于控制条显示） */
  snapshots: Record<string, { pairsCount: number; title: string; url: string } | null>;
  /** 初始化：订阅主进程冻结状态变化 */
  init: () => () => void;
  /** 触发冻结（先抓取入库再 pause） */
  doFreeze: (tabId: string, profileId: string) => Promise<void>;
  /** 恢复 */
  doResume: (tabId: string) => Promise<void>;
  /** 彻底分离 */
  doDetach: (tabId: string) => Promise<void>;
  /** 同步单个 tab 状态（切换标签时查询） */
  syncStatus: (tabId: string) => Promise<void>;
}

export const useFreezeStore = create<FreezeStore>((set, get) => ({
  states: {},
  snapshots: {},

  init: () => {
    const offState = onFreezeStateChanged(({ tabId, state }) => {
      set((s) => ({
        states: { ...s.states, [tabId]: state },
      }));
      // 恢复/分离后清除快照
      if (state !== 'frozen') {
        set((s) => {
          const snaps = { ...s.snapshots };
          delete snaps[tabId];
          return { snapshots: snaps };
        });
      }
    });
    // 窗口 move/resize 后主进程请求重新上报 webview 位置（冻结态点击命中检测）
    const offRect = onFreezeSyncRect(({ tabIds }) => {
      for (const tabId of tabIds) {
        const info = getWebviewRect(tabId);
        if (info) reportFreezeRect({ tabId, ...info });
      }
    });
    return () => {
      offState();
      offRect();
    };
  },

  doFreeze: async (tabId, profileId) => {
    // 上报 webview 位置（窗口内 CSS 像素 + dpr），供冻结态点击命中检测
    const info = getWebviewRect(tabId);
    const result = await freezeTab({
      tabId,
      profileId,
      ...(info ?? {}),
    });
    if (result.frozen) {
      set((s) => ({
        states: { ...s.states, [tabId]: 'frozen' },
        snapshots: {
          ...s.snapshots,
          [tabId]: result.snapshot
            ? {
                pairsCount: result.snapshot.pairs.length,
                title: result.snapshot.title,
                url: result.snapshot.url,
              }
            : null,
        },
      }));
    }
  },

  doResume: async (tabId) => {
    await resumeFreeze(tabId);
    set((s) => ({
      states: { ...s.states, [tabId]: 'attached' },
    }));
  },

  doDetach: async (tabId) => {
    await detachFreeze(tabId);
    set((s) => {
      const states = { ...s.states };
      const snaps = { ...s.snapshots };
      delete states[tabId];
      delete snaps[tabId];
      return { states, snapshots: snaps };
    });
  },

  syncStatus: async (tabId) => {
    const status = await getFreezeStatus(tabId);
    set((s) => ({
      states: { ...s.states, [tabId]: status },
    }));
  },
}));
