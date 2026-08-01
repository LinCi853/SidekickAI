/* =====================================================================
   store/useUiVersionStore.ts —— 界面版本状态（纯状态层）
   仅管理 Zustand 状态 + localStorage 持久化。
   所有联动副作用（CSS 变量、主题、UI 比例、监听器等）
   统一委托给 lib/oxy-design-system.ts 控制器。
   ===================================================================== */

import { create } from 'zustand';
import {
  type UiVersion,
  activateOxy,
  deactivateOxy,
  initOxy,
  OXY_STORAGE_KEY,
} from '../lib/oxy-design-system';

// 从控制器重新导出类型，保持外部导入路径不变
export type { UiVersion } from '../lib/oxy-design-system';

/** 从 localStorage 读取界面版本，处理旧值 'v2' → 'oxy' 迁移 */
function readUiVersion(): UiVersion {
  try {
    const v = localStorage.getItem(OXY_STORAGE_KEY);
    if (v === 'classic') return 'classic';
    return 'oxy';
  } catch {
    return 'oxy';
  }
}

export interface UiVersionState {
  /** 当前界面版本，默认 'oxy'（Oxy Design System） */
  version: UiVersion;
  /** 切换界面版本：委托给 oxy-design-system 控制器执行所有联动 */
  setVersion: (v: UiVersion) => void;
  /** 初始化：委托给控制器执行（幂等，供 main.tsx 调用） */
  initUiVersion: () => void;
}

const initialVersion = readUiVersion();

export const useUiVersionStore = create<UiVersionState>((set) => ({
  version: initialVersion,

  setVersion: (v) => {
    if (v === 'oxy') {
      activateOxy();
    } else {
      deactivateOxy();
    }
    set({ version: v });
  },

  initUiVersion: () => {
    initOxy();
    set({ version: readUiVersion() });
  },
}));
