/* =====================================================================
   Oxy Color Engine — 动态颜色生成引擎
   从单一 hex 基础色生成完整色阶（50-900）、alpha 梯度、语义色偏移。
   纯函数模块，无 DOM 依赖。
   ===================================================================== */

import { OXY_CONTRAST } from './oxy-config';

/* ===== WCAG 对比度工具 ===== */

/**
 * 计算两个颜色之间的 WCAG 对比度比率。
 * @returns 对比度比率（1.0 ~ 21.0）
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 调整前景色使其与背景色达到最低对比度要求。
 * 通过 HSL 明度调整，选择变化最小的方向。
 *
 * @param fg 前景色 hex
 * @param bg 背景色 hex
 * @param minRatio 最低对比度（如 4.5）
 * @returns 调整后的前景色 hex
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  if (contrastRatio(fg, bg) >= minRatio) return fg;

  const { h, s } = hexToHsl(fg);

  // 尝试向暗和向亮两个方向调整，步长 2%
  let bestHex = fg;
  let bestDiff = Infinity;

  for (let l = 0; l <= 100; l += 2) {
    const candidate = hslToHex(h, s, l);
    const ratio = contrastRatio(candidate, bg);
    if (ratio >= minRatio) {
      const diff = Math.abs(l - hexToHsl(fg).l);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestHex = candidate;
      }
    }
  }

  return bestHex;
}

/* ===== HSL 转换工具 ===== */

export interface HSL { h: number; s: number; l: number; }

/** hex → HSL */
export function hexToHsl(hex: string): HSL {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { h: 240, s: 60, l: 55 }; // 兜底：靛蓝
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** HSL → hex */
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** hex → rgba */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(99,102,241,${alpha})`;
  return `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${alpha})`;
}

/** 计算颜色的相对亮度（WCAG），用于自动选择前景色 */
export function relativeLuminance(hex: string): number {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return 0.5;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(parseInt(m[1], 16)) + 0.7152 * lin(parseInt(m[2], 16)) + 0.0722 * lin(parseInt(m[3], 16));
}

/* ===== 色阶生成 ===== */

/**
 * 从基础色生成 10 阶色阶（50-900）。
 * 通过 HSL 明度梯度生成，色相和饱和度微调。
 */
export function generateColorScale(baseHex: string): Record<string, string> {
  const { h, s } = hexToHsl(baseHex);
  // 明度梯度：从极浅到极深
  const lightnessMap: Record<string, number> = {
    '50': 96, '100': 91, '200': 82, '300': 70,
    '400': 58, '500': 48, '600': 42, '700': 35,
    '800': 27, '900': 20,
  };
  // 饱和度微调：浅色稍降，深色稍升
  const saturationMap: Record<string, number> = {
    '50': Math.max(s - 15, 20), '100': Math.max(s - 10, 25),
    '200': Math.max(s - 5, 30), '300': s,
    '400': s, '500': s, '600': Math.min(s + 5, 90),
    '700': Math.min(s + 5, 90), '800': Math.min(s + 10, 95),
    '900': Math.min(s + 10, 95),
  };
  const result: Record<string, string> = {};
  for (const [key, l] of Object.entries(lightnessMap)) {
    result[key] = hslToHex(h, saturationMap[key], l);
  }
  return result;
}

/* ===== Alpha 梯度生成 ===== */

/** 从基础色生成 accent-alpha 系列变量 */
export function generateAlphaColors(baseHex: string): Record<string, string> {
  return {
    '--accent-90': hexToRgba(baseHex, 0.9),
    '--accent-75': hexToRgba(baseHex, 0.75),
    '--accent-50': hexToRgba(baseHex, 0.5),
    '--accent-25': hexToRgba(baseHex, 0.25),
    '--accent-10': hexToRgba(baseHex, 0.1),
    '--accent-05': hexToRgba(baseHex, 0.05),
  };
}

/* ===== 语义色偏移生成 ===== */

/**
 * 从基础色生成语义色（success/warning/destructive）。
 * 通过色相偏移保证与品牌色的区分度，同时保持可读对比度。
 */
export function generateSemanticColors(baseHex: string, bgHex = '#ffffff'): Record<string, string> {
  const { h, s } = hexToHsl(baseHex);

  // success：绿色系（H≈140°），保持中等饱和和高明度
  const successH = 140;
  const success = hslToHex(successH, Math.min(s + 10, 75), 42);

  // warning：琥珀色系（H≈38°），高明度保证可见性
  const warningH = 38;
  const warning = hslToHex(warningH, Math.min(s + 20, 85), 48);

  // destructive：红色系（H≈0°），高饱和
  const destructiveH = 0;
  const destructive = hslToHex(destructiveH, Math.min(s + 20, 80), 50);

  // warning / destructive foreground：保证与对应背景对比度 ≥ 4.5:1
  const warningForeground = chooseForegroundForContrast(warning);
  const destructiveForeground = chooseForegroundForContrast(destructive);

  // ring：品牌色 500 档
  const ring = hslToHex(h, s, 48);

  // accent 系列：作为文字/小面积强调使用时必须保证可读
  const accentBrightRaw = hslToHex(h, s, 58);
  const accentLightRaw = hslToHex(h, Math.max(s - 10, 30), 68);
  let accentBright = ensureContrast(accentBrightRaw, bgHex, OXY_CONTRAST.body);
  let accentLight = ensureContrast(accentLightRaw, bgHex, OXY_CONTRAST.body);
  // 额外保证：accent 作为文字时与白色背景/前景的辨识度
  if (contrastRatio('#ffffff', accentBright) < OXY_CONTRAST.large) {
    const darker = ensureContrast(accentBright, '#ffffff', OXY_CONTRAST.large);
    if (hexToHsl(darker).l < hexToHsl(accentBright).l) accentBright = darker;
  }
  if (contrastRatio('#ffffff', accentLight) < OXY_CONTRAST.large) {
    const darker = ensureContrast(accentLight, '#ffffff', OXY_CONTRAST.large);
    if (hexToHsl(darker).l < hexToHsl(accentLight).l) accentLight = darker;
  }
  const accentDim = hslToHex(h, s, 35);

  // accent 背景上的文字：在黑/白之间自动选择对比度更高的，并保证 ≥ 4.5:1
  const accentBrightForeground = chooseForegroundForContrast(accentBright);
  const accentLightForeground = chooseForegroundForContrast(accentLight);

  // primary：确保同时满足
  // 1) 与背景对比度 ≥ 4.5:1（WCAG AA）
  // 2) 与白色前景对比度 ≥ 3.0:1（确保大面积使用时不至于看不清白色文字/圆点）
  let primary = hslToHex(h, s, 42);
  if (contrastRatio(primary, bgHex) < OXY_CONTRAST.body) {
    // 尝试 600/700 阶
    const p600 = hslToHex(h, Math.min(s + 5, 90), 42);
    const p700 = hslToHex(h, Math.min(s + 5, 90), 35);
    if (contrastRatio(p600, bgHex) >= OXY_CONTRAST.body) primary = p600;
    else if (contrastRatio(p700, bgHex) >= OXY_CONTRAST.body) primary = p700;
    else primary = ensureContrast(primary, bgHex, OXY_CONTRAST.body);
  }

  // 如果 primary 与白色对比度仍不足，继续调暗
  if (contrastRatio('#ffffff', primary) < OXY_CONTRAST.large) {
    const darker = ensureContrast(primary, '#ffffff', OXY_CONTRAST.large);
    // 只在确实变暗了才采用（避免浅色背景下把颜色调得过亮）
    if (hexToHsl(darker).l < hexToHsl(primary).l) primary = darker;
  }

  // primary-foreground：在黑/白之间选择对比度更高的那个，并确保 ≥ 4.5:1
  let primaryForeground: string;
  const black = '#18181b';
  const white = '#ffffff';
  const blackRatio = contrastRatio(black, primary);
  const whiteRatio = contrastRatio(white, primary);
  primaryForeground = blackRatio >= whiteRatio ? black : white;
  if (contrastRatio(primaryForeground, primary) < OXY_CONTRAST.semantic) {
    primaryForeground = ensureContrast(primaryForeground, primary, OXY_CONTRAST.semantic);
  }

  return {
    '--primary': primary,
    '--primary-foreground': primaryForeground,
    '--ring': ring,
    '--success': success,
    '--warning': warning,
    '--warning-foreground': warningForeground,
    '--destructive': destructive,
    '--destructive-foreground': destructiveForeground,
    '--accent-bright': accentBright,
    '--accent-bright-foreground': accentBrightForeground,
    '--accent-light': accentLight,
    '--accent-light-foreground': accentLightForeground,
    '--accent-dim': accentDim,
  };
}

/**
 * 为指定背景色自动选择黑/白前景色，确保 WCAG 对比度 ≥ 4.5:1。
 */
function chooseForegroundForContrast(bgHex: string): string {
  const black = '#18181b';
  const white = '#ffffff';
  const blackRatio = contrastRatio(black, bgHex);
  const whiteRatio = contrastRatio(white, bgHex);
  let fg = blackRatio >= whiteRatio ? black : white;
  if (contrastRatio(fg, bgHex) < OXY_CONTRAST.semantic) {
    fg = ensureContrast(fg, bgHex, OXY_CONTRAST.semantic);
  }
  return fg;
}

/* ===== 完整主题生成 ===== */

/**
 * 从单一 hex 颜色生成完整的 CSS 变量键值对字典。
 * 包含品牌色阶、alpha 梯度、语义色、派生交互色。
 * 调用后可直接用于注入 :root。
 *
 * @param baseHex 主题基础色
 * @param bgHex 当前背景色，用于保证 primary 与背景的对比度。默认 #ffffff。
 */
export function generateFullTheme(baseHex: string, bgHex = '#ffffff'): Record<string, string> {
  const scale = generateColorScale(baseHex);
  const semantic = generateSemanticColors(baseHex, bgHex);
  const alpha = generateAlphaColors(baseHex);

  return {
    // 品牌色阶
    '--brand-50': scale['50'],
    '--brand-100': scale['100'],
    '--brand-200': scale['200'],
    '--brand-300': scale['300'],
    '--brand-400': scale['400'],
    '--brand-500': scale['500'],
    '--brand-600': scale['600'],
    '--brand-700': scale['700'],
    '--brand-800': scale['800'],
    '--brand-900': scale['900'],
    // 语义色
    ...semantic,
    // Alpha 梯度
    ...alpha,
    // 派生交互色
    '--accent': hexToRgba(baseHex, 0.08),
  };
}

/**
 * 为独立对话窗口等场景生成安全的 accent 变量集合。
 * 与全局主题不同，这里只覆盖 accent 相关变量，并保证文字可读。
 *
 * @param accentHex 用户配置的强调色
 * @param bgHex 当前背景色，用于对比度校验
 */
export function generateChatAccentVars(accentHex: string, bgHex = '#ffffff'): Record<string, string> {
  const semantic = generateSemanticColors(accentHex, bgHex);
  const bright = semantic['--accent-bright'];
  const light = semantic['--accent-light'];
  return {
    '--accent-bright': bright,
    '--accent-light': light,
    '--accent-dim': semantic['--accent-dim'],
    '--accent-bright-foreground': semantic['--accent-bright-foreground'],
    '--accent-light-foreground': semantic['--accent-light-foreground'],
    '--accent': hexToRgba(bright, 0.08),
  };
}
