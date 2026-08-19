/* =====================================================================
   pages/BrowserView/useCloudPcGamepadNav.ts —— 云电脑模式手柄空间导航自动开关
   行为（等效主窗口 Ctrl+G 的手柄/键盘空间导航）：
   - 云电脑模式开启且检测到手柄接入 → 立即在当前激活 webview 开启空间导航
   - 手柄接入事件丢失时兜底：开启后 300ms 间隔敏捷扫描 navigator.getGamepads()
   - 手柄断开 / 云电脑模式退出 → 自动关闭空间导航
   - 切换标签时，把当前目标状态应用到新激活的 webview
   依赖：webview 内已注入 buildSpatialNavScript()（BrowserWebviewTab dom-ready 注入）
   ===================================================================== */

import { useEffect, useRef, type RefObject } from 'react';
import { useCloudPcStore } from '../../store/useCloudPcStore';
import { useGamepadStore } from '../../store/useGamepadStore';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import type { WebviewElement } from '../../lib/webview';

export interface CloudPcGamepadNavOptions {
  /** webview 容器（查找当前激活标签的 webview） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 自动开启/关闭时的通知回调（如顶部提示条） */
  onAutoToggle?: (enabled: boolean) => void;
}

/** 敏捷扫描当前连接的手柄（gamepadconnected 事件丢失时的兜底） */
function scanConnectedPads(): { index: number; id: string; connected: boolean }[] {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const list: { index: number; id: string; connected: boolean }[] = [];
  for (const pad of pads) {
    if (pad) list.push({ index: pad.index, id: pad.id, connected: pad.connected });
  }
  return list;
}

/** 获取当前激活标签的 webview */
function getActiveWebview(containerRef: RefObject<HTMLDivElement | null>): WebviewElement | null {
  const activeId = useBrowserTabStore.getState().activeTabId;
  if (!activeId) return null;
  return (containerRef.current?.querySelector(
    'webview[data-tab-id="' + activeId + '"]',
  ) ?? null) as WebviewElement | null;
}

/** 设置空间导航开关状态（脚本已注入时生效） */
function setSpatialNav(containerRef: RefObject<HTMLDivElement | null>, enabled: boolean): boolean {
  const webview = getActiveWebview(containerRef);
  if (!webview) return false;
  webview.executeJavaScript(
    'window.__ai_spatial_nav__ && window.__ai_spatial_nav__.toggle(' + enabled + ')',
  ).catch(() => { /* webview 未就绪时忽略，dom-ready 路径会兜底 */ });
  return true;
}

/**
 * 云电脑模式手柄空间导航自动开关。
 * 调用位置：BrowserView 顶层（hooks 顺序稳定）。
 */
export function useCloudPcGamepadNav({ containerRef, onAutoToggle }: CloudPcGamepadNavOptions): void {
  const isCloudPc = useCloudPcStore((s) => s.isActive);
  const connectedCount = useGamepadStore((s) => s.connectedCount);
  const activeTabId = useBrowserTabStore((s) => s.activeTabId);

  /** 当前是否已自动开启（避免重复 toggle） */
  const autoOnRef = useRef(false);
  /** 通知回调 ref（避免父组件回调身份变化触发 effect 重跑） */
  const onAutoToggleRef = useRef(onAutoToggle);
  onAutoToggleRef.current = onAutoToggle;

  const desired = isCloudPc && connectedCount > 0;

  // 云电脑模式开启期间：敏捷扫描兜底（事件可能因页面无用户手势而丢失）
  // 发现手柄立即写入 store（GamepadIndicator 同步点亮，desired 随之成立）
  useEffect(() => {
    if (!isCloudPc) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      const list = scanConnectedPads();
      if (list.some((p) => p.connected)) {
        const store = useGamepadStore.getState();
        if (store.connectedCount === 0) {
          store.setConnections(list);
        }
        clearInterval(timer);
        return;
      }
      if (ticks >= 20) clearInterval(timer); // ≈6s 后停止，交由事件驱动
    }, 300);
    return () => clearInterval(timer);
  }, [isCloudPc]);

  // 目标状态翻转：自动开启 / 自动关闭
  useEffect(() => {
    if (desired && !autoOnRef.current) {
      autoOnRef.current = true;
      setSpatialNav(containerRef, true);
      onAutoToggleRef.current?.(true);
    } else if (!desired && autoOnRef.current) {
      autoOnRef.current = false;
      setSpatialNav(containerRef, false);
      onAutoToggleRef.current?.(false);
    }
  }, [desired, containerRef]);

  // 切换标签：把当前目标状态应用到新激活的 webview
  // （新标签可能尚未 dom-ready，由 BrowserWebviewTab 注入路径兜底）
  useEffect(() => {
    if (autoOnRef.current) {
      setSpatialNav(containerRef, true);
    }
  }, [activeTabId, containerRef]);

  // 窗口销毁：关闭空间导航
  useEffect(() => {
    return () => {
      if (autoOnRef.current) {
        autoOnRef.current = false;
        setSpatialNav(containerRef, false);
      }
    };
  }, [containerRef]);
}
