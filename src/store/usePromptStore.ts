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
  subscribed: boolean;
  loadError: boolean;

  /** 初始化：从主进程加载模板列表 */
  init: () => Promise<void>;
  /** 新增或更新模板（按 id upsert） */
  save: (template: PromptTemplate) => Promise<PromptTemplate>;
  /** 删除模板 */
  remove: (id: string) => Promise<void>;
}

export const usePromptStore = create<PromptStoreState>((set, get) => {
  let readRevision = 0;
  let clearRevision = 0;
  const subscribe = () => {
    if (get().subscribed) return;
    window.electron.onAiAssetsCleared(() => {
      readRevision += 1;
      clearRevision += 1;
      set({ prompts: [], initialized: true, loadError: false });
    });
    window.electron.onPromptsChanged(() => { void get().init(); });
    set({ subscribed: true });
  };
  const mutate = async <T,>(operation: () => Promise<T>): Promise<T> => {
    subscribe();
    readRevision += 1;
    const beforeClear = clearRevision;
    try {
      const result = await operation();
      if (beforeClear === clearRevision) await get().init();
      return result;
    } catch (failure) {
      if (beforeClear === clearRevision) await get().init();
      throw failure;
    }
  };
  return {
    prompts: [],
    initialized: false,
    subscribed: false,
    loadError: false,

    init: async () => {
      subscribe();
      const operation = ++readRevision;
      set({ loadError: false });
      try {
        const prompts = await listPrompts();
        if (operation === readRevision) set({ prompts, initialized: true, loadError: false });
      } catch (e) {
        if (operation === readRevision) {
          console.error('[usePromptStore.init] Failed to load templates:', e);
          set({ initialized: true, loadError: true });
        }
      }
    },

    save: (template) => mutate(() => savePrompt(template)),
    remove: (id) => mutate(() => deletePrompt(id)),
  };
});
