/* =====================================================================
   store/usePromptStore.ts —— 提示词模板状态管理（明输入明注入）
   维护提示词模板列表，提供 CRUD 操作，状态变更同步到主进程持久化。
   ===================================================================== */

import { create } from 'zustand';
import type { PromptTemplate } from '../lib/electron-api';
import { listPrompts, savePrompt, deletePrompt } from '../lib/electron-api';

export interface PromptStoreState {
  /** 提示词模板列表 */
  prompts: PromptTemplate[];
  /** 是否已初始化 */
  initialized: boolean;

  /** 初始化：从主进程加载模板列表 */
  init: () => Promise<void>;
  /** 新增或更新模板（按 id upsert） */
  save: (template: PromptTemplate) => Promise<PromptTemplate>;
  /** 删除模板 */
  remove: (id: string) => Promise<void>;
}

export const usePromptStore = create<PromptStoreState>((set) => ({
  prompts: [],
  initialized: false,

  init: async () => {
    try {
      const prompts = await listPrompts();
      set({ prompts, initialized: true });
      console.log('[usePromptStore.init] 加载完成，模板数:', prompts.length);
    } catch (e) {
      console.error('[usePromptStore.init] 加载失败:', e);
      set({ initialized: true });
    }
  },

  save: async (template) => {
    const saved = await savePrompt(template);
    set((s) => {
      const idx = s.prompts.findIndex((p) => p.id === saved.id);
      if (idx === -1) {
        return { prompts: [...s.prompts, saved] };
      }
      const next = [...s.prompts];
      next[idx] = saved;
      return { prompts: next };
    });
    return saved;
  },

  remove: async (id) => {
    await deletePrompt(id);
    set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
  },
}));
