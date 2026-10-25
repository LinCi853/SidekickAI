/* =====================================================================
   pages/onboarding/onboardingData.ts —— 引导页共享静态数据与热键解析
   职责：
   - PAGES / TOTAL_PAGES：分页定义与总页数（主文件底部导航与欢迎页提示共用）
   - resolveHotkey：全局热键 → 展示（动态读取用户自定义 accelerator 与启用状态）
   从 pages/OnboardingView.tsx 拆出，纯数据无副作用，不改变任何行为。
   ===================================================================== */

import type { HotkeyAction, HotkeyConfig } from '../../lib/electron-api'
import { formatAcc } from '../../lib/shortcut-reference'

// ==================== 分页定义 ====================

export const PAGES = [
  { id: 'welcome', title: '欢迎' },
  { id: 'windows', title: '认识窗口' },
  { id: 'personalize', title: '个性化' },
  { id: 'actions', title: '上手动作' },
  { id: 'finish', title: '开始使用' },
] as const

export const TOTAL_PAGES = PAGES.length

/** 使用指南「上手动作」页展示的高频主窗口操作（教学内容，与快捷键注册表独立维护） */
export const ONBOARDING_HIGH_FREQ: Array<{ keys: string; action: string; scope: string }> = [
  { keys: 'Alt + 1~9', action: '切换到第 N 个标签', scope: '窗口内' },
  { keys: 'Ctrl + Tab / Ctrl + Shift + Tab', action: '向前/向后循环切换标签', scope: '窗口内' },
  { keys: 'Ctrl + T', action: '脱离当前标签为独立窗口', scope: '窗口内' },
  { keys: 'Ctrl + W', action: '关闭当前标签', scope: '窗口内' },
  { keys: 'F10', action: '切换主题', scope: '应用内' },
  { keys: 'F12', action: '切换当前窗口置顶', scope: '应用内' },
]

/** 全局热键 → 展示（动态读取用户自定义 accelerator 与启用状态） */
export function resolveHotkey(
  hotkeys: HotkeyConfig[],
  action: HotkeyAction,
  fallback: string,
): {
  keys: string
  enabled: boolean
} {
  const cfg = hotkeys.find((h) => h.action === action)
  if (!cfg) return { keys: fallback, enabled: true }
  if (!cfg.enabled) return { keys: fallback, enabled: false }
  if (!cfg.accelerator) return { keys: fallback, enabled: true }
  return { keys: formatAcc(cfg.accelerator), enabled: true }
}
