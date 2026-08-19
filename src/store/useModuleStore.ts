/* =====================================================================
   store/useModuleStore.ts —— 模块管理状态（插件市场 / 开发者选项）
   维护全部可选模块的信息与状态；初始化时从主进程加载，并订阅
   MODULE_STATE_CHANGED 广播实时同步（跨窗口一致）。
   ===================================================================== */

import { create } from 'zustand';
import type { ModuleInfo } from '../lib/electron-api';
import {
  listModules,
  setModuleEnabled,
  clearModuleData,
  onModuleStateChanged,
} from '../lib/electron-api';

export interface ModuleStoreState {
  /** 全部模块信息（含启用/安装状态） */
  modules: ModuleInfo[];
  /** 是否已初始化 */
  initialized: boolean;
  /** 初始化后是否已挂载广播订阅（防重复订阅） */
  subscribed: boolean;

  /** 初始化：从主进程加载模块列表 + 订阅状态广播 */
  init: () => Promise<void>;
  /** 启用/禁用模块；返回 { ok, error? } */
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  /** 清除模块全部数据（不可逆） */
  clearData: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 查询模块是否启用（未注册一律 false） */
  isEnabled: (id: string) => boolean;
  /** 查询模块信息（未注册返回 undefined） */
  getModule: (id: string) => ModuleInfo | undefined;
}

export const useModuleStore = create<ModuleStoreState>((set, get) => ({
  modules: [],
  initialized: false,
  subscribed: false,

  init: async () => {
    try {
      const modules = await listModules();
      set({ modules, initialized: true });
      console.log(
        '[useModuleStore.init] 加载完成，模块数:',
        modules.length,
        '启用:',
        modules.filter((m) => m.enabled).map((m) => m.id).join(',') || '（无）',
      );
    } catch (e) {
      console.error('[useModuleStore.init] 加载失败:', e);
      set({ initialized: true });
    }
    // 广播订阅只挂一次（各窗口组件可能多次调用 init）
    if (!get().subscribed) {
      onModuleStateChanged(({ modules }) => {
        set({ modules });
      });
      set({ subscribed: true });
    }
  },

  setEnabled: async (id, enabled) => {
    const result = await setModuleEnabled(id, enabled);
    if (result.ok) {
      // 广播会推送最新列表；此处立即刷新兜底（本窗口为主进程来源时广播同样到达）
      const modules = await listModules();
      set({ modules });
    }
    return result;
  },

  clearData: async (id) => {
    const result = await clearModuleData(id);
    return result;
  },

  isEnabled: (id) => get().modules.find((m) => m.id === id)?.enabled ?? false,

  getModule: (id) => get().modules.find((m) => m.id === id),
}));
