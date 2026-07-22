/* =====================================================================
   lib/prompt-hotkey.ts —— 提示词局内快捷键工具（需求 2.5）
   - keyEventToAccelerator: 将 KeyboardEvent 归一化为 Electron accelerator 字符串
   - APP_HOTKEY_PRESETS: 应用内置的局内快捷键（用于冲突检测）
   - detectPromptHotkeyConflicts: 检查 prompt 列表中的快捷键冲突
   ===================================================================== */

import type { HotkeyConfig, PromptTemplate } from './electron-api';

/**
 * 将 KeyboardEvent 归一化为 Electron accelerator 字符串（如 "Ctrl+Shift+1"）。
 * - 至少需要一个修饰键（Ctrl/Alt/Shift/Meta），否则返回 null（普通字符不视为快捷键）
 * - 纯修饰键按下（如单独 Ctrl）返回 null
 * - 单字符 key 转大写；空格转为 "Space"
 */
export function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  // 至少一个修饰键才视为快捷键
  if (mods.length === 0) return null;

  let key = e.key;
  // 纯修饰键按下（key === 'Control' 等）：跳过
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  // 空格归一化为 Space
  if (key === ' ') key = 'Space';
  // 单字符转大写
  if (key.length === 1) key = key.toUpperCase();
  // 其他特殊键（F1-F12、ArrowLeft 等）保持原样

  return [...mods, key].join('+');
}

/**
 * 应用内置的局内快捷键列表（不依赖主进程配置，硬编码用于冲突检测）。
 * 来源：
 * - useHotkeys.ts: Alt+1~9, Ctrl+Tab, Ctrl+Shift+Tab
 * - useMainViewKeyboard.ts: F4, F5, F6, Ctrl+T, Ctrl+W, ESC（无修饰键的不算冲突）
 * - 主进程全局热键（Alt+Space, Alt+Q 等）通过 getHotkeys() 动态获取，此处不列出
 */
export const APP_HOTKEY_PRESETS: Array<{ label: string; accelerator: string }> = [
  { label: '切换到第 N 个标签', accelerator: 'Alt+1' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+2' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+3' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+4' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+5' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+6' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+7' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+8' },
  { label: '切换到第 N 个标签', accelerator: 'Alt+9' },
  { label: '切换到下一个标签', accelerator: 'Ctrl+Tab' },
  { label: '切换到上一个标签', accelerator: 'Ctrl+Shift+Tab' },
  { label: '脱离当前标签', accelerator: 'Ctrl+T' },
  { label: '关闭当前标签', accelerator: 'Ctrl+W' },
];

/**
 * 构建冲突检测所需的其他热键列表。
 * 合并：应用内置局内快捷键 + 主进程全局热键 + 其他提示词模板的快捷键。
 *
 * @param appHotkeys 主进程全局热键列表（来自 getHotkeys()）
 * @param currentPromptId 当前正在编辑的 prompt id（用于排除自身）
 * @param allPrompts 全部提示词模板列表
 * @returns otherHotkeys 数组，传给 HotkeyRecorder
 */
export function buildOtherHotkeysForPrompt(
  appHotkeys: HotkeyConfig[],
  currentPromptId: string | null,
  allPrompts: PromptTemplate[],
): Array<{ label: string; accelerator: string }> {
  const result: Array<{ label: string; accelerator: string }> = [
    ...APP_HOTKEY_PRESETS,
    ...appHotkeys
      .filter((h) => h.enabled && h.accelerator)
      .map((h) => ({ label: h.label, accelerator: h.accelerator })),
    ...allPrompts
      .filter((p) => p.id !== currentPromptId && p.hotkey)
      .map((p) => ({ label: `提示词「${p.title}」`, accelerator: p.hotkey as string })),
  ];
  return result;
}

/**
 * 检测 prompt 列表中的快捷键冲突。
 * 返回冲突的 prompt 列表（与 APP_HOTKEY_PRESETS / appHotkeys 冲突，或 prompt 之间互相冲突）。
 *
 * 用于 MainView 注册前过滤：冲突的 prompt 快捷键被跳过并记录警告日志。
 */
export function detectPromptHotkeyConflicts(
  prompts: PromptTemplate[],
  appHotkeys: HotkeyConfig[],
): Map<string, string> {
  // accelerator → 占用者 label
  const occupied = new Map<string, string>();
  for (const preset of APP_HOTKEY_PRESETS) {
    occupied.set(preset.accelerator, preset.label);
  }
  for (const h of appHotkeys) {
    if (h.enabled && h.accelerator) {
      occupied.set(h.accelerator, h.label);
    }
  }

  const conflicts = new Map<string, string>(); // promptId → 冲突描述
  const promptOccupied = new Map<string, string>(); // accelerator → promptTitle（用于 prompt 之间冲突）

  for (const p of prompts) {
    if (!p.hotkey) continue;
    const acc = p.hotkey;
    // 与应用快捷键冲突
    const appConflict = occupied.get(acc);
    if (appConflict) {
      conflicts.set(p.id, `「${p.title}」快捷键 ${acc} 与应用内置「${appConflict}」冲突，已跳过`);
      continue;
    }
    // 与其他 prompt 冲突
    const otherPrompt = promptOccupied.get(acc);
    if (otherPrompt) {
      conflicts.set(p.id, `「${p.title}」快捷键 ${acc} 与「${otherPrompt}」重复，已跳过`);
      continue;
    }
    promptOccupied.set(acc, p.title);
  }

  return conflicts;
}
