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
  type FreezeState,
  type TextLayer,
} from '../lib/electron-api';

interface FreezeStore {
  /** tabId → 冻结状态 */
  states: Record<string, FreezeState>;
  /** 冻结时抓取的快照信息（用于控制条显示） */
  snapshots: Record<string, { pairsCount: number; title: string; url: string } | null>;
  /** 冻结前提取的文本层（冻结态选择层选中/复制用） */
  textLayers: Record<string, TextLayer>;
  /** 初始化：订阅主进程冻结状态变化 */
  init: () => () => void;
  /** 触发冻结（先抓取入库 + 提取文本层再 pause） */
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
  textLayers: {},

  init: () => {
    return onFreezeStateChanged(({ tabId, state }) => {
      set((s) => ({
        states: { ...s.states, [tabId]: state },
      }));
      // 恢复/分离后清除快照与文本层
      if (state !== 'frozen') {
        set((s) => {
          const snaps = { ...s.snapshots };
          const layers = { ...s.textLayers };
          delete snaps[tabId];
          delete layers[tabId];
          return { snapshots: snaps, textLayers: layers };
        });
      }
    });
  },

  doFreeze: async (tabId, profileId) => {
    const result = await freezeTab({ tabId, profileId });
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
        textLayers: {
          ...s.textLayers,
          [tabId]: result.textLayer ?? { items: [], scrollOffsetY: 0, contentHeight: 0, viewportHeight: 0 },
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
