/* =====================================================================
   store/useZoomStore.ts —— 页面缩放状态（右上角缩放浮窗）
   缩放动作（快捷键 / 右键菜单）后写入缩放级别并显示浮窗 2.5s；
   浮窗 hover 时保持显示，提供 放大 / 缩小 / 重置 交互。
   ===================================================================== */

import { create } from 'zustand';

interface ZoomStoreState {
  /** 当前缩放级别（log2 尺度，0=100%） */
  level: number;
  /** 浮窗是否可见 */
  visible: boolean;
  /** 显示浮窗（写入级别 + 自动隐藏计时由组件控制） */
  show: (level: number) => void;
  /** 隐藏浮窗 */
  hide: () => void;
  /** 仅更新级别（浮窗已显示时同步） */
  setLevel: (level: number) => void;
}

export const useZoomStore = create<ZoomStoreState>((set) => ({
  level: 0,
  visible: false,
  show: (level) => set({ level, visible: true }),
  hide: () => set({ visible: false }),
  setLevel: (level) => set({ level }),
}));

/** 缩放级别 → 百分比文本（如 1 → '200%'） */
export function zoomLevelToPercent(level: number): string {
  const factor = Math.pow(2, level);
  return Math.round(factor * 100) + '%';
}
