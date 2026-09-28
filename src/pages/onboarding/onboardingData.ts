/* =====================================================================
   pages/onboarding/onboardingData.ts —— 引导页共享静态数据与热键解析
   职责：
   - PAGES / TOTAL_PAGES：分页定义与总页数（主文件底部导航与欢迎页提示共用）
   - resolveHotkey：全局热键 → 展示（动态读取用户自定义 accelerator 与启用状态）
   从 pages/OnboardingView.tsx 拆出，纯数据无副作用，不改变任何行为。
   ===================================================================== */

import type { HotkeyAction, HotkeyConfig } from '../../lib/electron-api';
import { formatAcc } from '../../lib/shortcut-reference';

// ==================== 分页定义 ====================

export const PAGES = [
  { id: 'welcome', title: '欢迎' },
  { id: 'windows', title: '认识窗口' },
  { id: 'personalize', title: '个性化' },
  { id: 'actions', title: '上手动作' },
  { id: 'finish', title: '开始使用' },
] as const;

export const TOTAL_PAGES = PAGES.length;

/** 全局热键 → 展示（动态读取用户自定义 accelerator 与启用状态） */
export function resolveHotkey(hotkeys: HotkeyConfig[], action: HotkeyAction, fallback: string): {
  keys: string;
  enabled: boolean;
} {
  const cfg = hotkeys.find((h) => h.action === action);
  if (!cfg) return { keys: fallback, enabled: true };
  if (!cfg.enabled) return { keys: fallback, enabled: false };
  if (!cfg.accelerator) return { keys: fallback, enabled: true };
  return { keys: formatAcc(cfg.accelerator), enabled: true };
}
