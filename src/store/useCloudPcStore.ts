/* =====================================================================
   store/useCloudPcStore.ts —— 云电脑模式状态（渲染层）
   与主进程 cloud-pc.ts 双向同步：
   - 渲染层 enter/exit → IPC BROWSER_CLOUD_PC_SET → 主进程挂起/恢复全局热键
   - 主进程兜底退出（Ctrl+Alt+Shift+F12 / 双击 Esc）→ BROWSER_CLOUD_PC_CHANGED
     → 本 store 同步为 false（BrowserView 订阅后退出全屏 UI）
   ===================================================================== */

import { create } from 'zustand';

/** 缩放模式：auto=自动匹配远端分辨率；manual=用户手动指定缩放因子 */
export type CloudPcZoomMode = 'auto' | 'manual';

interface CloudPcStoreState {
  /** 云电脑模式是否激活 */
  isActive: boolean;
  /** 渲染层激活/停用（不含主进程同步，由 BrowserView 统一处理） */
  setActive: (active: boolean) => void;
  /** 内容缩放因子（4K 屏跑 1080P 云电脑时放大画面铺满屏幕；1=不缩放） */
  zoomFactor: number;
  /** 缩放模式（auto=自动检测远端视频分辨率匹配） */
  zoomMode: CloudPcZoomMode;
  /** 检测到的远端视频分辨率（调试/提示展示） */
 remoteResolution: { width: number; height: number } | null;
  setZoom: (factor: number, mode?: CloudPcZoomMode) => void;
  setRemoteResolution: (r: { width: number; height: number } | null) => void;
  reset: () => void;
}

export const useCloudPcStore = create<CloudPcStoreState>((set) => ({
  isActive: false,
  setActive: (active) => set({ isActive: active }),
  zoomFactor: 1,
  zoomMode: 'auto',
  remoteResolution: null,
  setZoom: (factor, mode) => set((s) => ({ zoomFactor: factor, zoomMode: mode ?? s.zoomMode })),
  setRemoteResolution: (r) => set({ remoteResolution: r }),
  reset: () => set({ isActive: false, zoomFactor: 1, zoomMode: 'auto', remoteResolution: null }),
}));
