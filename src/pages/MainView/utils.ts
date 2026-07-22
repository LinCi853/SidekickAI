import type { AIPlatform, Profile } from '../../lib/electron-api';

/** 暖色系渐变色板，用于平台标签图标背景 */
export const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#c25a4a', '#823328'],
  ['#e07a64', '#a8463a'],
  ['#d9462f', '#f59e42'],
  ['#b8584a', '#6a3545'],
  ['#e0a064', '#a8633a'],
  ['#9a4a6a', '#5a2a3a'],
  ['#c2724a', '#824328'],
  ['#d9685a', '#a8363a'],
  ['#b86a4a', '#7a3a28'],
];

export function gradientFor(id: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return GRADIENTS[h % GRADIENTS.length];
}

/** 平台颜色对（themeColor + gradientColor），用于渐变背景 */
export interface PlatformColors {
  themeColor: string;
  gradientColor: string;
}

/**
 * 解析平台颜色，fallback 链：
 *   profile.aiThemeColor ?? platform.themeColor ?? gradientFor(id)
 * - 用户在 Profile 上覆盖 aiThemeColor 时优先使用（gradientColor 优先取平台定义，缺失时回退 aiThemeColor）
 * - 否则用平台定义的 themeColor + gradientColor
 * - 都没有时回退到暖色哈希板（gradientFor）
 */
export function getPlatformColors(
  profile: Profile | null | undefined,
  platform: AIPlatform | null | undefined,
  fallbackId: string,
): PlatformColors {
  if (profile?.aiThemeColor) {
    return {
      themeColor: profile.aiThemeColor,
      gradientColor: platform?.gradientColor ?? profile.aiThemeColor,
    };
  }
  if (platform) {
    return {
      themeColor: platform.themeColor,
      gradientColor: platform.gradientColor,
    };
  }
  const [c1, c2] = gradientFor(fallbackId);
  return { themeColor: c1, gradientColor: c2 };
}

/** 简单字符串哈希（djb2 变体），用于对话内容去重，非密码学用途 */
export function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
