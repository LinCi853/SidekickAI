/* =====================================================================
   store/useWindowStore.ts —— 主窗口形态与可见性状态
   维护主 UI 窗口的置顶状态。
   迁移到 Electron 后：window.electron.window 操作的是 Profile 窗口，
   主窗口的置顶/显隐由主进程全局热键（Ctrl+Space）处理，本 store 仅维护
   主窗口的 UI 态（如置顶开关），不再直接调 Tauri 命令。
   ===================================================================== */

import { create } from 'zustand';

export interface WindowState {
  /** 主 UI 窗口是否置顶 */
  alwaysOnTop: boolean;
  /** 主 UI 窗口是否可见（响应全局热键显隐事件） */
  visible: boolean;

  /** 初始化：默认可见 + 不置顶 */
  init: () => void;
  /** 切换主窗口置顶态（仅维护 UI 态，主窗口置顶由主进程控制） */
  setAlwaysOnTop: (onTop: boolean) => void;
  /** 设置可见性 */
  setVisible: (visible: boolean) => void;
  /** 标记主窗口已显示 */
  show: () => void;
  /** 标记主窗口已隐藏 */
  hide: () => void;
}

export const useWindowStore = create<WindowState>((set) => ({
  alwaysOnTop: false,
  visible: true,

  init: () => {
    set({ alwaysOnTop: false, visible: true });
  },

  setAlwaysOnTop: (onTop) => set({ alwaysOnTop: onTop }),

  setVisible: (visible) => set({ visible }),

  show: () => set({ visible: true }),

  hide: () => set({ visible: false }),
}));
