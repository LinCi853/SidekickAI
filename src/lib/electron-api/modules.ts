/* =====================================================================
   lib/electron-api/modules.ts —— 模块管理渲染层 API 包装
   对接 window.electron.modules（electron/preload/modules.ts）。
   ===================================================================== */

import { requireElectron } from './core';
import type { ModuleInfo, ModuleStateChangedPayload } from './core';

/** 列出全部模块信息（含启用/安装状态） */
export function listModules(): Promise<ModuleInfo[]> {
  return requireElectron().modules.list();
}

/** 启用/禁用模块（大模块未安装时返回 error 提示补装） */
export function setModuleEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return requireElectron().modules.setEnabled(id, enabled);
}

/** 清除模块全部数据（不可逆，需调用方二次确认） */
export function clearModuleData(id: string): Promise<{ ok: boolean; error?: string }> {
  return requireElectron().modules.clearData(id);
}

/** 订阅模块状态变更广播（返回取消订阅函数） */
export function onModuleStateChanged(
  callback: (payload: ModuleStateChangedPayload) => void,
): () => void {
  return requireElectron().modules.onStateChanged(callback);
}
