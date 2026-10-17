/* =====================================================================
   lib/electron-api/platform.ts —— 平台能力查询（权限状态）
   对应 window.electron.platformCapabilities
   ===================================================================== */

import type { PlatformCapabilities, RuntimeProcessSnapshot } from '../../../electron/shared/types';
import type { TabHibernationStats } from '../../../electron/shared/tab-hibernation.types';
import { requireElectron } from './core';

/**
 * 获取当前平台的能力矩阵（安全存储、全局快捷键、辅助功能权限等）。
 * 设置页"权限与安全"分区调用此函数展示当前权限状态。
 */
export function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const api = requireElectron();
  return api.platformCapabilities.get();
}

export function getRuntimeProcesses(): Promise<RuntimeProcessSnapshot> {
  return requireElectron().runtimeProcesses.get();
}

/** 休眠记录数量与占位快照磁盘占用 */
export function getTabHibernationStats(): Promise<TabHibernationStats> {
  return requireElectron().tabHibernation.stats();
}

/** 同步各窗口当前激活/有声标签，主进程据此把非激活 guest 降为低优先级 */
export function syncTabProcessPriority(payload: {
  windowId: string;
  activeTabId: string | null;
  audibleTabIds?: string[];
}): Promise<boolean> {
  return requireElectron().runtimeProcesses.syncPriority(payload);
}
