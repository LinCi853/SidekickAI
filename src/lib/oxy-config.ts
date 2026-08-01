/* =====================================================================
   Oxy Design System — 统一参数配置中心
   修改此文件可调整所有 Oxy 模式的计算参数。
   所有引擎文件从此导入参数，不硬编码任何数值。
   ===================================================================== */

// ═══════════════════════════════════════════
// DPI 曲线
// ═══════════════════════════════════════════

export const OXY_DPI_CONFIG = {
  /**
   * scale=1.0 对应的参考维度（逻辑像素）。
   * 1440 对应 2K / 4K@150%，作为 scale=1.0 基准。
   */
  referenceDimension: 1440,
  /**
   * 幂指数（<1 时前段陡、后段缓）。
   * 0.5 = 平方根，自然映射分辨率差异。
   */
  exponent: 0.5,
  /** scale 下限：低分辨率不再继续缩小 */
  scaleFloor: 0.70,
  /** scale 上限：高分辨率不再继续放大 */
  scaleCeiling: 1.12,
} as const;

// ═══════════════════════════════════════════
// 属性调节器
// null = 全范围跟随 scale，不 clamp
// ═══════════════════════════════════════════

export interface AdjusterConfig {
  min: number | null;
  max: number | null;
}

export const OXY_ADJUSTERS = {
  /** 文字字号：低 scale 时适当拉高，高 scale 时限制增幅 */
  text:     { min: 1.0, max: 1.05 } as AdjusterConfig,
  /** 图标尺寸：低 scale 时保证最小可识别尺寸 */
  icon:     { min: 0.95, max: 1.08 } as AdjusterConfig,
  /** 间距：全范围跟随 */
  spacing:  { min: null, max: null } as AdjusterConfig,
  /** 圆角：过大/过小视觉不协调 */
  radius:   { min: 0.85, max: 1.15 } as AdjusterConfig,
  /** 标题栏/标签栏高度：低 scale 时保持可操作高度 */
  titlebar: { min: 1.0, max: 1.05 } as AdjusterConfig,
  /** 窗口尺寸上限：全范围跟随 */
  window:   { min: null, max: null } as AdjusterConfig,
} as const;

// ═══════════════════════════════════════════
// 基础尺寸（standard 档位，作为 scale=1.0 的基准）
// ═══════════════════════════════════════════

export const OXY_BASE_VALUES = {
  icon: 30,
  titlebarH: 46,
  tabsH: 38,
  /** textBase=16：scale=1.0 时 textBase=16 > 旧版 medium(15)，4K@150% 大于中档 */
  textBase: 16,
  spaceUnit: 5,
  radius: 12,
} as const;

/**
 * textBase 绝对下限：保证低分辨率（720p）时字号不低于 12。
 * 旧版 small textBase=13，720p 比其略小合理。
 */
export const OXY_TEXT_FLOOR = 12;

// ═══════════════════════════════════════════
// 窗口尺寸
// ═══════════════════════════════════════════

export const OXY_WINDOWS = {
  main: {
    defaultWidthBase: 420,
    defaultWidthMin: 420,
    defaultHeightMin: 600,
    defaultHeightMax: 900,
    defaultHeightScreenRatio: 0.85,
    maxWidthRatio: 0.95,
    maxHeightRatio: 0.95,
  },
  advancedPanel: {
    widthMin: 720,
    widthScreenRatioMin: 0.6,
    widthScreenRatioMax: 0.8,
    heightMin: 560,
    heightScreenRatioMin: 0.7,
    heightScreenRatioMax: 0.85,
  },
  chat: {
    widthMin: 720,
    widthScreenRatioMin: 0.6,
    widthScreenRatioMax: 0.8,
    heightMin: 500,
    heightScreenRatioMin: 0.7,
    heightScreenRatioMax: 0.85,
  },
} as const;

// ═══════════════════════════════════════════
// 面板尺寸
// ═══════════════════════════════════════════

export const OXY_PANELS = {
  settings: { widthMin: 300, widthMax: 720, parentRatio: 0.7 },
  sidebar:  { widthMin: 120, widthMax: 400, parentRatio: 0.25 },
} as const;

// ═══════════════════════════════════════════
// 二级页面/遮罩
// ═══════════════════════════════════════════

export const OXY_OVERLAYS = {
  contextMenu: { widthMin: 160, parentRatio: 0.8 },
  modal:       { widthMin: 320, widthMax: 600, parentRatio: 0.5, heightMin: 200, heightParentRatio: 0.8 },
  tooltip:     { widthMin: 200, parentRatio: 0.7 },
} as const;

// ═══════════════════════════════════════════
// 颜色对比度（WCAG）
// ═══════════════════════════════════════════

export const OXY_CONTRAST = {
  /** 正文文字最低对比度 */
  body: 4.5,
  /** 大标题文字（≥18px）最低对比度 */
  large: 3.0,
  /** 边框可见性最低对比度 */
  border: 1.5,
  /** 语义色 foreground vs 背景最低对比度 */
  semantic: 4.5,
} as const;

// ═══════════════════════════════════════════
// localStorage 键
// ═══════════════════════════════════════════

export const OXY_STORAGE_KEYS = {
  overrides: 'sidekick-oxy-overrides',
  uiVersion: 'sidekick-ui-version',
  userUiScale: 'sidekick-user-ui-scale',
  appColor: 'sidekick-active-app-color',
} as const;

// ═══════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════

/**
 * 应用属性调节器到 scale 值。
 * @param scale 原始 scale 系数
 * @param adjuster 属性调节器配置
 * @returns 调节后的有效 scale
 */
export function applyAdjuster(scale: number, adjuster: AdjusterConfig): number {
  if (adjuster.min !== null && scale < adjuster.min) return adjuster.min;
  if (adjuster.max !== null && scale > adjuster.max) return adjuster.max;
  return scale;
}

/**
 * 计算连续 DPI scale 系数（统一幂函数公式）。
 *
 * 取屏幕逻辑宽高的较小值作为参考维度，适配竖屏/超宽屏：
 *   scale = clamp((minDim / reference) ^ exponent, floor, ceiling)
 *
 * @param logicalWidth  逻辑像素宽度（物理宽度 / scaleFactor）
 * @param logicalHeight 逻辑像素高度（物理高度 / scaleFactor）
 * @returns scale 系数
 */
export function computeDpiScale(logicalWidth: number, logicalHeight: number): number {
  const { referenceDimension, exponent, scaleFloor, scaleCeiling } = OXY_DPI_CONFIG;
  const minDim = Math.min(logicalWidth, logicalHeight);
  const raw = Math.pow(minDim / referenceDimension, exponent);
  return Math.max(scaleFloor, Math.min(scaleCeiling, raw));
}
