/**
 * 跨模块共享的工具函数。
 *
 * 提取自 useHotkeys / useLongPressTab / useShortcutsToggle / AppSwitcher / MainView
 * 等多个模块中重复实现的逻辑，集中维护避免修改遗漏。
 */

import type { AIPlatform, Profile } from './electron-api';

/**
 * 判断事件目标是否为可输入元素（input/textarea/select/contenteditable）。
 *
 * 用于快捷键处理：当焦点在输入元素时跳过全局快捷键，避免影响正常输入。
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/**
 * 按 AI 平台匹配全部 Profile（先按 aiPlatformId，再按 aiPlatformUrl 兜底），按 order 升序排序。
 *
 * 用于"一个平台可创建多个独立 AI 应用"的场景，返回所有匹配的 Profile 列表。
 * 同一平台多实例时，UI 需遍历此列表渲染每张卡片。
 */
export function findProfilesByPlatform(platform: AIPlatform, profiles: Profile[]): Profile[] {
  return profiles
    .filter(
      (p) => p.isAIPlatform && (p.aiPlatformId === platform.id || p.aiPlatformUrl === platform.url),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 按 AI 平台匹配对应的 Profile（兼容别名，取 findProfilesByPlatform 的第一个）。
 *
 * 历史调用方仅需单个 Profile 时使用；新代码推荐使用 findProfilesByPlatform 以支持多实例。
 * 为什么同时匹配 id 和 url：历史数据中部分 Profile 仅有 aiPlatformUrl 而无 aiPlatformId，
 * 双重匹配保证旧数据兼容。
 */
export function findProfileByPlatform(platform: AIPlatform, profiles: Profile[]): Profile | undefined {
  return findProfilesByPlatform(platform, profiles)[0];
}

/**
 * 获取全部 AI 应用 Profile（扁平遍历，按 order 升序排序）。
 *
 * 用于三处 UI（AppSwitcher / BottomBar / AiAppSection）的统一渲染：
 * 不再按平台分组遍历，而是扁平遍历所有 isAIPlatform 的 Profile，
 * 每个 Profile 一张卡片，支持同一平台创建多个独立 AI 应用实例。
 * 拖拽排序时直接基于返回的 Profile.id 数组重新排序。
 */
export function findAiAppProfiles(profiles: Profile[]): Profile[] {
  return profiles
    .filter((p) => p.isAIPlatform)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
