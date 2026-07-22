/* =====================================================================
   lib/electron-api/onboarding.ts —— 引导 API 渲染进程封装
   对接主进程 IPC_CHANNELS.ONBOARDING_* 通道。
   ===================================================================== */

import { requireElectron } from './core';
import type { AppSettings } from './core';

/** 打开引导窗（单例，已存在则聚焦） */
export function showOnboardingWindow(): Promise<void> {
  return requireElectron().onboarding.show();
}

/** 查询引导是否已完成 */
export function isOnboardingCompleted(): Promise<boolean> {
  return requireElectron().onboarding.isCompleted();
}

/**
 * 完成引导：合并保存快速设置 patch 到 app-settings，标记 onboardingCompleted=true，
 * 关闭引导窗，显示主窗口（首次启动时主窗口才隐藏，二次查看时主窗口已显示，此调用幂等）。
 */
export function completeOnboarding(patch?: Partial<AppSettings>): Promise<void> {
  return requireElectron().onboarding.complete(patch);
}
