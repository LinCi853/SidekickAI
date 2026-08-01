/* =====================================================================
   Oxy Layout Engine V2 — 动态布局计算引擎
   基于连续 DPI scale 系数 + 属性调节器计算所有布局数值。
   纯函数模块，无 DOM 依赖。计算结果通过 Oxy 控制器注入为 CSS 变量。
   ===================================================================== */

import {
  OXY_BASE_VALUES,
  OXY_ADJUSTERS,
  OXY_TEXT_FLOOR,
  applyAdjuster,
  computeDpiScale,
  type AdjusterConfig,
} from './oxy-config';

/** OxyScale 保留为类型，用于 CSS 属性标记（信息性，不再驱动计算） */
export type OxyScale = 'compact' | 'standard' | 'spacious';

/** 布局计算结果 */
export interface OxyLayout {
  /** 连续 scale 系数（0.88~1.12） */
  scale: number;
  /** UI 比例档位（信息性，供 CSS 选择器使用） */
  uiScale: OxyScale;
  /** 顶栏高度（px） */
  titlebarH: number;
  /** 标签栏高度（px） */
  tabsH: number;
  /** 顶栏图标尺寸（px） */
  titlebarIcon: number;
  /** SVG 图标尺寸 */
  iconSvg: number;
  /** SVG 图标小号尺寸 */
  iconSvgSm: number;
  /** 间距网格 */
  space: Record<string, number>;
  /** 字号 */
  text: Record<string, number>;
  /** 圆角 */
  radius: Record<string, number>;
  /** 标签栏收起态高度 */
  tabBarCollapsedH: number;
  /** 标签栏单行展开高度 */
  tabBarExpandedH: number;
  /** 标签栏最大行数 */
  tabBarMaxRows: number;
  /** 页面边距上限 */
  pageMarginMax: number;
  /** 侧边栏最大宽度 */
  sidebarMaxW: number;
  /** 面板最大宽度 */
  panelMaxW: number;
  /** 窗口最小宽度 */
  windowMinW: number;
  /** 窗口最小高度 */
  windowMinH: number;
  /** 窗口最大宽度 */
  windowMaxW: number;
  /** 窗口最大高度 */
  windowMaxH: number;
}

/**
 * 将连续 scale 映射到 OxyScale 档位（信息性，供 CSS 属性使用）。
 */
export function scaleToOxyScale(scale: number): OxyScale {
  if (scale < 0.93) return 'compact';
  if (scale < 1.05) return 'standard';
  return 'spacious';
}

/**
 * @deprecated 使用 computeDpiScale + scaleToOxyScale 替代。
 */
export function detectOxyScale(screenWidth: number, screenHeight: number): OxyScale {
  const scale = computeDpiScale(screenWidth, screenHeight);
  return scaleToOxyScale(scale);
}

/**
 * 计算属性最终值 = 基础值 × scale × adjuster(scale)
 */
function scaled(base: number, scale: number, adjuster: AdjusterConfig): number {
  return Math.round(base * scale * applyAdjuster(scale, adjuster));
}

/**
 * 根据连续 scale 系数和屏幕尺寸计算完整布局。
 * 所有数值由 JS 动态决定，不依赖 CSS 固定档位。
 *
 * @param scale 连续 DPI scale 系数（0.88~1.12）
 * @param screenWidth 屏幕逻辑宽度
 * @param screenHeight 屏幕逻辑高度
 */
export function computeLayout(scale: number, screenWidth: number, screenHeight: number): OxyLayout {
  const oxyScale = scaleToOxyScale(scale);

  // 图标和标题栏：使用 icon adjuster
  const titlebarIcon = scaled(OXY_BASE_VALUES.icon, scale, OXY_ADJUSTERS.icon);
  const titlebarH = scaled(OXY_BASE_VALUES.titlebarH, scale, OXY_ADJUSTERS.titlebar);
  const tabsH = scaled(OXY_BASE_VALUES.tabsH, scale, OXY_ADJUSTERS.titlebar);
  const iconSvg = Math.round(titlebarIcon * 0.65);
  const iconSvgSm = Math.round(titlebarIcon * 0.65 * 0.85);

  // 间距：全范围跟随
  const u = Math.max(3, Math.round(OXY_BASE_VALUES.spaceUnit * scale));
  const space: Record<string, number> = {
    '0-25': Math.max(1, Math.round(u * 0.25)),
    '0-5':  Math.max(2, Math.round(u * 0.5)),
    '0-75': Math.max(3, Math.round(u * 0.75)),
    '1':    u,
    '1-25': Math.round(u * 1.25),
    '1-5':  Math.round(u * 1.5),
    '1-75': Math.round(u * 1.75),
    '2':    Math.round(u * 2),
    '2-25': Math.round(u * 2.25),
    '2-5':  Math.round(u * 2.5),
    '2-75': Math.round(u * 2.75),
    '3':    Math.round(u * 3),
    '3-5':  Math.round(u * 3.5),
    '4':    Math.round(u * 4),
    '4-5':  Math.round(u * 4.5),
    '5':    Math.round(u * 5),
    '5-5':  Math.round(u * 5.5),
    '6':    Math.round(u * 6),
    '8':    Math.round(u * 8),
    '10':   Math.round(u * 10),
    '12':   Math.round(u * 12),
    '16':   Math.round(u * 16),
    '20':   Math.round(u * 20),
  };

  // 字号：限制 ±5%，并保证不低于 OXY_TEXT_FLOOR（1080p 时略大于旧版 small）
  const tb = Math.max(OXY_TEXT_FLOOR, scaled(OXY_BASE_VALUES.textBase, scale, OXY_ADJUSTERS.text));
  const text: Record<string, number> = {
    'xs': tb - 2,
    'sm': tb - 1,
    'base': tb,
    'md': tb + 1,
    'lg': tb + 3,
    'xl': tb + 5,
    '2xl': tb + 7,
    '3xl': tb + 11,
    '4xl': tb + 19,
    '5xl': tb + 29,
  };

  // 圆角：clamp
  const r = scaled(OXY_BASE_VALUES.radius, scale, OXY_ADJUSTERS.radius);
  const radius: Record<string, number> = {
    '2xs': Math.max(2, r - 8),
    'xs':  Math.max(3, r - 6),
    'sm':  r - 2,
    'md':  r,
    'lg':  r + 2,
    'xl':  r + 4,
    '2xl': r + 8,
    'full': 9999,
  };

  // 标签栏
  const tabBarCollapsedH = 0;
  const tabBarExpandedH = tabsH;
  const tabBarMaxRows = 2;

  // 边界与距离上限
  const pageMarginMax = Math.min(Math.round(screenWidth * 0.04), 24);
  const sidebarMaxW = Math.min(Math.round(screenWidth * 0.2), 320);
  const panelMaxW = Math.min(Math.round(screenWidth * 0.6), 800);

  // 窗口尺寸
  const minIcons = 6 * titlebarIcon;
  const minGaps = 5 * space['0-25'];
  const minDrag = 80;
  const minPadding = 2 * space['2'];
  const windowMinW = Math.ceil((minIcons + minGaps + minDrag + minPadding + 120) / 10) * 10;
  const windowMinH = 520;
  const windowMaxW = Math.round(screenWidth * 0.95);
  const windowMaxH = Math.round(screenHeight * 0.95);

  return {
    scale,
    uiScale: oxyScale,
    titlebarH,
    tabsH,
    titlebarIcon,
    iconSvg,
    iconSvgSm,
    space,
    text,
    radius,
    tabBarCollapsedH,
    tabBarExpandedH,
    tabBarMaxRows,
    pageMarginMax,
    sidebarMaxW,
    panelMaxW,
    windowMinW,
    windowMinH,
    windowMaxW,
    windowMaxH,
  };
}

/* ===== 标签栏布局计算 ===== */

/**
 * 计算标签栏展开时的实际需要高度（支持两行）。
 */
export function computeTabBarHeight(
  tabCount: number,
  availableWidth: number,
  maxChipWidth: number,
  rowHeight: number,
  maxRows: number,
): number {
  if (tabCount === 0) return 0;
  const chipsPerRow = Math.max(1, Math.floor(availableWidth / maxChipWidth));
  const rowsNeeded = Math.ceil(tabCount / chipsPerRow);
  const actualRows = Math.min(rowsNeeded, maxRows);
  return actualRows * rowHeight;
}

/* ===== CSS 变量注入辅助 ===== */

/**
 * 将 OxyLayout 转换为 CSS 变量键值对字典。
 * 用于注入 :root，覆盖 base.css 和 scale.css 中的静态值。
 */
export function layoutToCssVars(layout: OxyLayout): Record<string, string> {
  const vars: Record<string, string> = {
    '--titlebar-h': `${layout.titlebarH}px`,
    '--tabs-h': `${layout.tabsH}px`,
    '--titlebar-icon': `${layout.titlebarIcon}px`,
    '--icon-svg': `${layout.iconSvg}px`,
    '--icon-svg-sm': `${layout.iconSvgSm}px`,
    '--toggle-w': `calc(var(--titlebar-icon) * 1.85)`,
    '--toggle-h': `calc(var(--titlebar-icon) * 0.9)`,
    '--btn-h': `calc(var(--titlebar-icon) * 0.82)`,
    '--toggle-pad': `calc(var(--toggle-h) * 0.15)`,
    '--toggle-knob': `calc(var(--toggle-h) - var(--toggle-pad) * 2)`,
    '--sidebar-w': `calc(var(--titlebar-icon) * 9)`,
    '--chat-input-min-h': `calc(var(--titlebar-icon) * 1.4)`,
    '--app-grid-item-w': `calc(var(--titlebar-icon) * 2.6)`,
    '--expanded-btn-w': `calc(var(--titlebar-icon) * 3.1)`,
    '--panel-min-w': `calc(var(--titlebar-icon) * 11)`,
    '--panel-max-w': `${layout.panelMaxW}px`,
    '--page-margin-max': `${layout.pageMarginMax}px`,
    '--sidebar-max-w': `${layout.sidebarMaxW}px`,
    '--window-min-w': `${layout.windowMinW}px`,
    '--window-min-h': `${layout.windowMinH}px`,
  };

  for (const [key, val] of Object.entries(layout.space)) {
    vars[`--space-${key}`] = `${val}px`;
  }
  for (const [key, val] of Object.entries(layout.text)) {
    vars[`--text-${key}`] = `${val}px`;
  }
  for (const [key, val] of Object.entries(layout.radius)) {
    vars[`--radius-${key}`] = `${val}px`;
  }

  return vars;
}
