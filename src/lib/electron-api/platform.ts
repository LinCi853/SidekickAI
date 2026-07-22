/* =====================================================================
   lib/electron-api/platform.ts —— 平台能力查询（权限状态）
   对应 window.electron.platformCapabilities
   ===================================================================== */

import type { PlatformCapabilities } from '../../../electron/shared/types';
import { requireElectron } from './core';

/**
 * 获取当前平台的能力矩阵（安全存储、全局快捷键、辅助功能权限等）。
 * 设置页"权限与安全"分区调用此函数展示当前权限状态。
 */
export function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const api = requireElectron();
  return api.platformCapabilities.get();
}
