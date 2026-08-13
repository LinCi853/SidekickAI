/* =====================================================================
   store/useFreezeStore.ts —— 页面冻结状态管理（防撤回保险）
   按 tabId 维护冻结状态，供 UI 显示指示器 + 控制条。
   ===================================================================== */

import { create, type StoreApi } from 'zustand';
import {
  freezeTab,
  toggleFreeze,
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
  /** 主进程状态版本，用于丢弃晚到的旧响应 */
  revisions: Record<string, number>;
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
  /** 按主进程真实状态冻结或恢复 */
  doToggle: (tabId: string, profileId: string) => Promise<void>;
  /** 彻底分离 */
  doDetach: (tabId: string) => Promise<void>;
  /** 同步单个 tab 状态（切换标签时查询） */
  syncStatus: (tabId: string) => Promise<void>;
}

export const useFreezeStore = create<FreezeStore>((set, get) => ({
  states: {},
  revisions: {},
  snapshots: {},
  textLayers: {},

  init: () => {
    return onFreezeStateChanged(({ tabId, state, revision }) => {
      if (revision < (get().revisions[tabId] ?? 0)) return;
      set((s) => ({
        states: { ...s.states, [tabId]: state },
        revisions: { ...s.revisions, [tabId]: revision },
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
    applyResult(set, get, tabId, result);
  },

  doResume: async (tabId) => {
    const revision = get().revisions[tabId];
    const ok = await resumeFreeze(tabId);
    if (ok && get().revisions[tabId] === revision) clearFrozenData(set, tabId, 'attached');
  },

  doToggle: async (tabId, profileId) => {
    const result = await toggleFreeze({ tabId, profileId });
    applyResult(set, get, tabId, result);
  },

  doDetach: async (tabId) => {
    const ok = await detachFreeze(tabId);
    if (!ok) {
      await get().syncStatus(tabId);
      return;
    }
    set((s) => {
      const states = { ...s.states };
      const snaps = { ...s.snapshots };
      const layers = { ...s.textLayers };
      const revisions = { ...s.revisions };
      delete states[tabId];
      delete snaps[tabId];
      delete layers[tabId];
      delete revisions[tabId];
      return { states, snapshots: snaps, textLayers: layers, revisions };
    });
  },

  syncStatus: async (tabId) => {
    const before = get().states[tabId];
    const revision = get().revisions[tabId];
    const status = await getFreezeStatus(tabId);
    if (get().states[tabId] !== before || get().revisions[tabId] !== revision) return;
    set((s) => ({
      states: { ...s.states, [tabId]: status },
    }));
  },
}));

type FreezeSet = StoreApi<FreezeStore>['setState'];

const EMPTY_TEXT_LAYER: TextLayer = {
  version: 2,
  coordinateSpace: 'guest-visual-viewport-css-px-v2',
  items: [],
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  contentWidth: 0,
  contentHeight: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  visualScale: 1,
  devicePixelRatio: 1,
  quality: 'none',
  truncated: false,
};

function clearFrozenData(
  set: FreezeSet,
  tabId: string,
  state: FreezeState,
  revision?: number,
): void {
  set((s: FreezeStore) => {
    const snapshots = { ...s.snapshots };
    const textLayers = { ...s.textLayers };
    delete snapshots[tabId];
    delete textLayers[tabId];
    return {
      states: { ...s.states, [tabId]: state },
      revisions: revision === undefined
        ? s.revisions
        : { ...s.revisions, [tabId]: revision },
      snapshots,
      textLayers,
    };
  });
}

function applyResult(
  set: FreezeSet,
  get: () => FreezeStore,
  tabId: string,
  result: Awaited<ReturnType<typeof freezeTab>>,
): void {
  if (result.revision < (get().revisions[tabId] ?? 0)) return;
  if (result.state !== 'frozen') {
    clearFrozenData(set, tabId, result.state, result.revision);
    return;
  }
  const existing = get();
  set((s: FreezeStore) => ({
    states: { ...s.states, [tabId]: 'frozen' },
    revisions: { ...s.revisions, [tabId]: result.revision },
    snapshots: {
      ...s.snapshots,
      [tabId]: result.snapshot
        ? {
            pairsCount: result.snapshot.pairs.length,
            title: result.snapshot.title,
            url: result.snapshot.url,
          }
        : existing.snapshots[tabId] ?? null,
    },
    textLayers: {
      ...s.textLayers,
      [tabId]: result.textLayer ?? existing.textLayers[tabId] ?? EMPTY_TEXT_LAYER,
    },
  }));
}
