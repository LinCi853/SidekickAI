/* =====================================================================
   pages/BrowserView/RecentClosedStore.ts —— 最近关闭标签（v0.0.9）
   内存态 zustand store，不持久化（重启后清空）。限 10 条。
   closeTab 时推入，点击可在新标签恢复。
   仅当前窗口范围，跨窗口不共享。
   ===================================================================== */

import { create } from 'zustand';

export interface RecentClosedEntry {
  /** 原标签 id（用于去重，恢复时生成新 id） */
  id: string;
  title: string;
  url: string;
  favicon?: string;
  /** 关闭时间戳（ms） */
  closedAt: number;
}

export interface RecentClosedState {
  entries: RecentClosedEntry[];
  /** 推入一条最近关闭记录（超过 10 条时丢弃最旧的） */
  push: (entry: RecentClosedEntry) => void;
  /** 移除指定条目（恢复时调用） */
  remove: (id: string) => void;
  /** 清空全部 */
  clear: () => void;
}

const MAX_ENTRIES = 10;

export const useRecentClosedStore = create<RecentClosedState>((set) => ({
  entries: [],

  push: (entry) => {
    set((s) => {
      // 同 URL 去重（保留最新关闭的）
      const filtered = s.entries.filter((e) => e.url !== entry.url);
      return { entries: [entry, ...filtered].slice(0, MAX_ENTRIES) };
    });
  },

  remove: (id) => {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
  },

  clear: () => set({ entries: [] }),
}));
