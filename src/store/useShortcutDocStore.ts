/* =====================================================================
   store/useShortcutDocStore.ts —— 快捷键注册表（注册即声明）
   快捷键的实现方在注册行为时一并声明说明（键位/作用/类别/备注），
   不再维护独立的事后文档表。页面打开时各行为 hook 依次把条目注册
   进本表（扫描即完成、数据常备），ShortcutsModal 只读快照渲染。

   - source 分组：同一来源重复注册为整体替换（幂等，便于实时更新：
     改键、启停、模块/设置变化时重新注册即可）
   - category 两类：'global'（全局）/ 'page'（页面内），弹窗仅用颜色区分
   - flatten 按 id 去重（同一键位可能被多条路径实现，声明一次即可），
     全局条目排前、页面条目在后
   ===================================================================== */

import { useEffect } from 'react';
import { create } from 'zustand';

/** 快捷键类别（弹窗仅两类，颜色区分） */
export type ShortcutDocCategory = 'global' | 'page';

/** 一条快捷键说明（注册时随行为一并声明） */
export interface ShortcutDoc {
  /** 稳定唯一 ID，如 'main.tab-detach' */
  id: string;
  /** 展示键位，如 'Ctrl + T'、'Alt + 1~9' */
  keys: string;
  /** 动作描述 */
  action: string;
  category: ShortcutDocCategory;
  note?: string;
  /** 运行时灰显（如全局热键被用户禁用、云电脑模式键位直通远端） */
  disabled?: boolean;
}

interface ShortcutDocState {
  /** 来源 → 该来源声明的条目（注册顺序即展示顺序） */
  sources: Record<string, ShortcutDoc[]>;
  /** 注册（整体替换该来源的条目） */
  register: (source: string, entries: ShortcutDoc[]) => void;
  /** 注销来源（实现方卸载时清理） */
  unregister: (source: string) => void;
}

export const useShortcutDocStore = create<ShortcutDocState>((set) => ({
  sources: {},
  register: (source, entries) =>
    set((state) => ({ sources: { ...state.sources, [source]: entries } })),
  unregister: (source) =>
    set((state) => {
      if (!(source in state.sources)) return state;
      const sources = { ...state.sources };
      delete sources[source];
      return { sources };
    }),
}));

/** 展示快照：全局在前、页面在后，按来源注册顺序，id 去重 */
export function selectShortcutDocs(sources: Record<string, ShortcutDoc[]>): ShortcutDoc[] {
  const global: ShortcutDoc[] = [];
  const page: ShortcutDoc[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(sources)) {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      (entry.category === 'global' ? global : page).push(entry);
    }
  }
  return [...global, ...page];
}

/** 非 React 上下文的注册入口（异步扫描流程内使用，语义与 hook 相同） */
export function registerShortcutDocs(source: string, entries: ShortcutDoc[]): void {
  useShortcutDocStore.getState().register(source, entries);
}

export function unregisterShortcutDocs(source: string): void {
  useShortcutDocStore.getState().unregister(source);
}

/**
 * 声明注册 hook：挂载时把条目注册进表，卸载时注销；
 * entries 引用变化（内容序列化比较）时整体替换——动态条目
 * （改键、启停、用户配置的局部快捷键）传新数组即可实时更新。
 * 仅依赖 React 的 useEffect（注册表本身命令式读写），
 * 兼容不带 useSyncExternalStore 的 hook 测试 harness。
 */
export function useRegisterShortcutDocs(source: string, entries: ShortcutDoc[]): void {
  const serialized = JSON.stringify(entries);
  useEffect(() => {
    const { register, unregister } = useShortcutDocStore.getState();
    register(source, JSON.parse(serialized) as ShortcutDoc[]);
    return () => unregister(source);
  }, [source, serialized]);
}
