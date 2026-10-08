/* =====================================================================
   lib/shortcut-reference.ts —— 快捷键参考数据（单一事实来源）
   全局热键元信息与窗口内快捷键列表统一在此维护，供：
   - components/ShortcutsModal.tsx（完整速查弹窗，` ~ / ? 呼出）
   - pages/OnboardingView.tsx（使用指南「上手动作」页，仅展示高频子集）
   避免两处硬编码漂移。
   ===================================================================== */

import type { HotkeyAction } from '../lib/electron-api';

/** 全局热键展示元信息（accelerator 运行时从主进程 getHotkeys() 动态获取） */
export interface GlobalHotkeyMeta {
  action: HotkeyAction;
  /** 未获取到用户配置时的回退展示值 */
  fallbackKeys: string;
  /** 动作描述 */
  actionText: string;
  note?: string;
}

/** 前 3 项全局热键的元信息（toggleVoice 默认无 accelerator，仅在速查弹窗按需展示） */
export const GLOBAL_HOTKEY_META: GlobalHotkeyMeta[] = [
  { action: 'toggleMainWindow', fallbackKeys: 'Alt + Space', actionText: '呼出/隐藏主窗口' },
  { action: 'toggleDetachedWindows', fallbackKeys: 'Alt + Q', actionText: '打开进阶面板' },
  { action: 'backgroundVoice', fallbackKeys: 'Alt + V', actionText: '后台语音录入（按住说话，松开发送）' },
];

/** 窗口内 / 应用内快捷键参考条目 */
export interface AppShortcutRef {
  keys: string;
  action: string;
  scope: '窗口内' | '应用内';
  note?: string;
}

/** 应用内 / 窗口内快捷键（硬编码事实：与主进程 before-input-event、渲染层 keydown 实现对应） */
export const APP_SHORTCUTS: AppShortcutRef[] = [
  { keys: 'Alt + 1~9', action: '切换到第 N 个标签', scope: '窗口内' },
  { keys: 'Ctrl + Tab / Ctrl + Shift + Tab', action: '向前/向后循环切换标签', scope: '窗口内' },
  { keys: 'Ctrl + 1/2/3', action: '切换进阶面板标签（对话/白板/笔记）', scope: '窗口内' },
  { keys: 'Ctrl + T', action: '脱离当前标签为独立窗口', scope: '窗口内' },
  { keys: 'Ctrl + W', action: '关闭当前标签', scope: '窗口内' },
  { keys: '双击标题', action: '编辑标签标题', scope: '窗口内' },
  { keys: 'F4', action: '后退（当前标签）', scope: '应用内' },
  { keys: 'F5', action: '刷新当前标签', scope: '应用内' },
  { keys: 'F6', action: '聚焦地址栏/AI 输入框（循环）', scope: '应用内' },
  { keys: 'F10', action: '切换主题', scope: '应用内' },
  { keys: 'F12', action: '切换当前窗口置顶', scope: '应用内', note: '最大化/全屏时不可用' },
  { keys: 'Ctrl + G', action: '切换手柄/键盘空间导航', scope: '应用内' },
  { keys: '` / ~ / ?', action: '呼出/关闭快捷键说明窗口', scope: '应用内' },
];

/** 使用指南「上手动作」页展示的高频子集（按 keys 精确匹配 APP_SHORTCUTS） */
export const ONBOARDING_SHORTCUT_KEYS = [
  'Alt + 1~9',
  'Ctrl + Tab / Ctrl + Shift + Tab',
  'Ctrl + T',
  'Ctrl + W',
  'F10',
  'F12',
];

/** accelerator 'Alt+Space' → 'Alt + Space'（统一展示格式） */
export function formatAcc(acc: string): string {
  return acc
    .split('+')
    .map((p) => p.trim())
    .join(' + ');
}
