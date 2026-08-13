// shared/window-size.ts — 窗口最小尺寸动态计算（纯函数，无 electron 依赖）
//
// 根据 UI 比例、实际可见的顶栏元素数量、元素间距动态计算窗口 minWidth，
// 避免任何窗口在三档 UI 下出现挤压。
//
// 所有尺寸常量均从实际 CSS 代码中提取（非估算），来源标注在注释中。
// 与 src/styles/design-tokens.css 中三档 UI 比例变量保持同步。
//
// 本文件为纯函数模块，主进程与渲染层共用同一份计算逻辑，确保窗口创建时
// (BrowserWindow 构造参数 minWidth) 与 UI 比例变化时 (setMinimumSize) 一致。

/** UI 比例档位 */
export type UiScale = 'small' | 'medium' | 'large'

/**
 * 三档 UI 比例下的顶栏真实尺寸常量（从 CSS 代码提取，非估算）。
 *
 * 数据来源：src/styles/design-tokens.css:179-228（[data-ui-scale="small|medium|large"]）
 *   small:  design-tokens.css:183-193
 *   medium: design-tokens.css:200-209
 *   large:  design-tokens.css:217-226
 *
 * 每个字段的 CSS 变量映射与提取行号：
 *   icon            ← --titlebar-icon           (design-tokens.css:192/209/226)
 *   primaryGap      ← --space-0-25              (design-tokens.css:185/202/219)
 *   actionsGap      ← --space-0-5               (design-tokens.css:185/202/219)
 *   appSwitcherMarg ← --space-1                 (design-tokens.css:183/200/217)
 *   sidePadding     ← --space-2                 (design-tokens.css:183/200/217)
 *   separatorWidth  ← .top-bar-separator width  (MainView/styles.css:148，三档固定 1px)
 *   textBase        ← --text-base               (design-tokens.css:180/197/214)
 *                     .top-bar-title font-size  (MainView/styles.css:77)
 */
export const UI_SCALE_CONFIG: Record<UiScale, {
  icon: number             // --titlebar-icon：按钮宽高
  primaryGap: number       // --space-0-25：顶栏一级子元素间距
  actionsGap: number       // --space-0-5：actions 内 gap / 分隔符 margin / nav margin-left
  appSwitcherMargin: number // --space-1：AppSwitcher wrap 的 margin-left
  sidePadding: number      // --space-2：顶栏单侧 padding（左右各一个）
  separatorWidth: number   // .top-bar-separator width（三档固定 1px）
  textBase: number         // --text-base：标题字号（.top-bar-title font-size）
}> = {
  small:  { icon: 22, primaryGap: 1,   actionsGap: 2,   appSwitcherMargin: 4, sidePadding: 8,  separatorWidth: 1, textBase: 13 },
  medium: { icon: 28, primaryGap: 1,   actionsGap: 2.5, appSwitcherMargin: 5, sidePadding: 9,  separatorWidth: 1, textBase: 15 },
  large:  { icon: 34, primaryGap: 1,   actionsGap: 3,   appSwitcherMargin: 6, sidePadding: 10, separatorWidth: 1, textBase: 17 },
}

/** 顶栏可自定义按钮组（与 api.types.ts TopBarButtonGroup 同步） */
type TopBarButtonGroup = 'uaToggle' | 'navBack' | 'navForward' | 'navHome' | 'themeToggle' | 'pinToggle'

/**
 * 拖拽区最小宽度下限。
 * CSS 中 .top-bar-drag { min-width: 0; flex: 1; }（MainView/styles.css:67），
 * 理论上可压缩到 0px，但拖拽区需容纳标题文本 + 100% 余量（见 calculateTitleWidth）。
 * 此下限仅在标题为空时兜底，确保窗口标题栏仍可被拖拽移动。
 */
const DRAG_REGION_MIN_FLOOR = 8

/**
 * 估算文本在指定字号下的渲染宽度（px）。
 *
 * 纯函数实现（无 DOM 依赖），用于 minWidth 计算。基于 .top-bar-title 的样式：
 *   font-family: var(--font-sans) = "Geist", "Exo 2", ui-sans-serif, system-ui, ...
 *   font-weight: 600（MainView/styles.css:78）
 *
 * 字符宽度估算规则（font-weight:600 下）：
 *   - CJK 字符（中日韩，U+4E00-U+9FFF 等）：宽度 ≈ font-size（全角方形）
 *   - 全角标点（U+3000-U+303F, U+FF00-U+FFEF）：宽度 ≈ font-size
 *   - ASCII 字符：宽度 ≈ 0.6 × font-size（Geist/Exo 2 等标准 sans-serif 半角）
 *   - 其他：宽度 ≈ 0.6 × font-size
 *
 * @param text 文本内容
 * @param fontSize 字号（px）
 * @returns 估算宽度（px）
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  if (!text) return 0
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字 + CJK 扩展A + 全角标点 + 全角ASCII
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) ||  // CJK 统一表意文字
      (code >= 0x3400 && code <= 0x4dbf) ||  // CJK 扩展A
      (code >= 0x3000 && code <= 0x303f) ||  // CJK 标点
      (code >= 0xff00 && code <= 0xffef)     // 全角形式
    width += isCJK ? fontSize : fontSize * 0.6
  }
  return width
}

/**
 * 计算主窗口的最小宽度。
 *
 * 基于顶栏实际 DOM 结构（src/pages/MainView/TopBar.tsx:120-348）逐元素累加，
 * 所有尺寸从 CSS 真实值提取（见 UI_SCALE_CONFIG 注释），非估算。
 *
 * 拖拽区宽度按标题文本宽度 × 2 计算（100% 余量），确保标题完整显示且
 * 两侧留有等宽拖拽区域。标题为空时使用 DRAG_REGION_MIN_FLOOR 兜底。
 *
 * 顶栏布局结构（左→右，一级子元素由 .top-bar 的 gap=primaryGap 分隔）：
 *
 *   .top-bar (padding: 0 sidePadding; gap: primaryGap)
 *   ├── .app-switcher-wrap (margin-left: appSwitcherMargin)   [常驻]
 *   │   └── AppSwitcher button (icon×icon)
 *   ├── UA IconButton (icon×icon)                             [可选 uaToggle]
 *   ├── .nav-btn-group (margin-left: actionsGap; 内部 gap: primaryGap)
 *   │   ├── 后退 IconButton (icon×icon)                       [可选 navBack]
 *   │   └── 前进 IconButton (icon×icon)                       [可选 navForward]
 *   ├── 刷新 IconButton (icon×icon)                           [常驻]
 *   ├── 主页 IconButton (icon×icon)                           [可选 navHome]
 *   ├── .top-bar-drag (flex:1, min-width:0 → 标题宽度×2)
 *   │   └── .top-bar-title (font-size: textBase, font-weight:600)
 *   └── .top-bar-actions (gap: actionsGap)
 *       ├── 菜单 IconButton (icon×icon)                       [常驻]
 *       ├── 主题 IconButton (icon×icon)                       [可选 themeToggle]
 *       ├── 置顶 IconButton (icon×icon)                       [可选 pinToggle]
 *       ├── .top-bar-separator (width:1px + margin:0 actionsGap)
 *       ├── 最小化 IconButton (icon×icon)                     [常驻]
 *       ├── 最大化 IconButton (icon×icon)                     [常驻]
 *       └── 关闭 IconButton (icon×icon)                       [常驻]
 *
 * 常驻 icon 按钮：AppSwitcher + 刷新 + 菜单 + 最小化 + 最大化 + 关闭 = 6
 * 可选 icon 按钮：UA + 后退 + 前进 + 主页 + 主题 + 置顶（由 visibleButtons 决定）
 *
 * @param uiScale UI 比例档位
 * @param visibleButtons 实际可见的可选按钮组（未传则按全部 6 个可选计算）
 * @param titleText 当前窗口标题文本（未传则按默认 '工百窗' 计算）
 */
export function calculateMainWindowMinWidth(
  uiScale: UiScale,
  visibleButtons?: TopBarButtonGroup[],
  titleText?: string,
): number {
  const cfg = UI_SCALE_CONFIG[uiScale]
  const buttons = visibleButtons ?? (['uaToggle', 'navBack', 'navForward', 'navHome', 'themeToggle', 'pinToggle'] as TopBarButtonGroup[])
  const title = titleText ?? '工百窗'

  const hasUa = buttons.includes('uaToggle')
  const hasNavBack = buttons.includes('navBack')
  const hasNavForward = buttons.includes('navForward')
  const hasNavHome = buttons.includes('navHome')
  const hasTheme = buttons.includes('themeToggle')
  const hasPin = buttons.includes('pinToggle')
  // nav-btn-group 作为一级子元素，只要后退/前进至少一个可见就存在
  const hasNavGroup = hasNavBack || hasNavForward

  // ===== icon 按钮总数（常驻 6 + 可选可见数）=====
  const alwaysVisibleIcons = 6
  const optionalIcons =
    (hasUa ? 1 : 0) + (hasNavBack ? 1 : 0) + (hasNavForward ? 1 : 0) +
    (hasNavHome ? 1 : 0) + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const iconCount = alwaysVisibleIcons + optionalIcons

  // ===== 一级子元素数与一级 gap 数 =====
  // 一级子元素：app-switcher-wrap(常驻) + UA? + navGroup? + 刷新(常驻) + 主页? + drag(常驻) + actions(常驻)
  const primaryElementCount = 4 + (hasUa ? 1 : 0) + (hasNavGroup ? 1 : 0) + (hasNavHome ? 1 : 0)
  const primaryGapCount = Math.max(0, primaryElementCount - 1)

  // ===== actions 内子元素数与 actions gap 数 =====
  // actions 子元素：菜单(常驻) + 主题? + 置顶? + separator(常驻) + 最小化(常驻) + 最大化(常驻) + 关闭(常驻)
  const actionsElementCount = 5 + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const actionsGapCount = Math.max(0, actionsElementCount - 1)

  // ===== nav-btn-group 额外占用 =====
  // margin-left: actionsGap（MainView/styles.css）+ 内部 gap: primaryGap（仅后退&前进都可见时）
  const navGroupExtra = hasNavGroup
    ? cfg.actionsGap + (hasNavBack && hasNavForward ? cfg.primaryGap : 0)
    : 0

  // ===== 分隔符总占用（width + 两侧 margin）=====
  const separatorTotal = cfg.separatorWidth + 2 * cfg.actionsGap

  // ===== 顶栏左右 padding 总和 =====
  const paddingTotal = 2 * cfg.sidePadding

  // ===== 拖拽区宽度 = 标题文本宽度 × 2（100% 余量）=====
  // .top-bar-title 绝对居中于 .top-bar-drag，标题两侧各留标题等宽空间用于拖拽
  const titleWidth = estimateTextWidth(title, cfg.textBase)
  const dragRegionWidth = Math.max(DRAG_REGION_MIN_FLOOR, titleWidth * 2)

  // ===== 汇总 =====
  const total =
    paddingTotal                          // 顶栏左右 padding
    + cfg.appSwitcherMargin               // AppSwitcher wrap margin-left
    + iconCount * cfg.icon                // 所有 icon 按钮总宽
    + primaryGapCount * cfg.primaryGap    // 一级 gap 总宽
    + navGroupExtra                       // nav-btn-group margin + 内部 gap
    + dragRegionWidth                     // 拖拽区（标题×2，含 100% 余量）
    + actionsGapCount * cfg.actionsGap    // actions 内 gap 总宽
    + separatorTotal                      // 分隔符 width + 两侧 margin

  return Math.ceil(total / 10) * 10
}

/** calculateMinWidthByElements 选项 */
export interface MinWidthOptions {
  /** 标题文本（默认 '工百窗'） */
  titleText?: string
  /** 标题宽度冗余系数（默认 1.2，即 20% 冗余） */
  titleScaleFactor?: number
  /** 基础冗余像素（默认 32，包含 padding/边距等） */
  baseRedundancy?: number
  /** 每字符像素宽度（默认 12，按 text-base 字号估算） */
  fontPixelPerChar?: number
}

/**
 * 根据元素数量、间距、标题文本冗余计算窗口最小宽度。
 * 用于 ChatView / AiApp 等辅助窗口（布局结构与主窗口不同，用通用公式估算）。
 *
 * 公式：
 *   width = elementCount * icon + gapCount * gap
 *         + (titleText.length * fontPixelPerChar * titleScaleFactor)
 *         + baseRedundancy
 * 返回向上取整到 10px。
 */
export function calculateMinWidthByElements(
  uiScale: UiScale,
  elementCount: number,
  gapCount: number,
  options: MinWidthOptions = {},
): number {
  const { icon, primaryGap: gap } = UI_SCALE_CONFIG[uiScale]
  const {
    titleText = '工百窗',
    titleScaleFactor = 1.2,
    baseRedundancy = 32,
    fontPixelPerChar = 12,
  } = options

  const elementsWidth = elementCount * icon
  const gapsWidth = gapCount * gap
  const titleWidth = titleText.length * fontPixelPerChar * titleScaleFactor
  const total = elementsWidth + gapsWidth + titleWidth + baseRedundancy
  return Math.ceil(total / 10) * 10
}

/**
 * 计算 ChatView 窗口的最小宽度。
 *
 * 6.1: 增大 elementCount 与基础冗余，使 medium 档至少 600px（横屏宽屏布局）。
 *
 * ChatView 顶栏元素计数：
 *   - 侧边栏切换(1) + 标题区(1) + provider 选择(1) + 用量 badge(1) + 置顶/最大化/最小化/关闭(4) = 8
 *   - gap 计数 ≈ 7
 * 增大 elementCount 至 17、baseRedundancy 至 80，使 medium 档（icon=28）算得 630px。
 */
export function calculateChatWindowMinWidth(uiScale: UiScale): number {
  const elementCount = 17
  const gapCount = 7
  return calculateMinWidthByElements(uiScale, elementCount, gapCount, {
    titleText: '自定义对话',
    baseRedundancy: 80,
  })
}

/**
 * 计算 进阶面板的最小宽度。
 *
 * AdvancedPanelView 顶栏元素计数：
 *   - 左侧分页切换(3) + 顶部操作按钮(4) = 7
 *   - gap 计数 ≈ 6
 */

/** 缓存的进阶面板最小宽度（模块级，一次计算，到处读取） */
let cachedAdvancedPanelMinWidth = 0

/**
 * 计算并缓存进阶面板最小宽度。
 * 在主窗口打开时、设置变更时调用一次即可。
 */
export function updateAdvancedPanelMinWidth(uiScale: UiScale): void {
  cachedAdvancedPanelMinWidth = calculateMainWindowMinWidth(uiScale)
}

/**
 * 获取缓存的进阶面板最小宽度。
 * 如果尚未初始化（缓存为 0），则按当前 UI 比例计算一次。
 */
export function getAdvancedPanelMinWidth(uiScale: UiScale): number {
  if (cachedAdvancedPanelMinWidth === 0) {
    cachedAdvancedPanelMinWidth = calculateMainWindowMinWidth(uiScale)
  }
  return cachedAdvancedPanelMinWidth
}

/** 主窗口最小高度（不受 UI 比例显著影响） */
export const MAIN_WINDOW_MIN_HEIGHT = 520
/** ChatView 窗口最小高度 */
export const CHAT_WINDOW_MIN_HEIGHT = 500
/** 进阶面板最小高度 */
export const ADVANCED_PANEL_MIN_HEIGHT = 560

/* ===== Oxy Design System V2 窗口尺寸计算 ===== */

/** Oxy UI 比例档位（信息性，V2 使用连续 scale） */
export type OxyScale = 'compact' | 'standard' | 'spacious'

/** Oxy 三档尺寸常量（与 oxy-layout-engine.ts SCALE_CONFIG 同步，仅向后兼容） */
export const OXY_SCALE_CONFIG: Record<OxyScale, {
  icon: number
  primaryGap: number
  actionsGap: number
  appSwitcherMargin: number
  sidePadding: number
  separatorWidth: number
  textBase: number
}> = {
  compact:  { icon: 26, primaryGap: 1,   actionsGap: 2,   appSwitcherMargin: 4, sidePadding: 8,  separatorWidth: 1, textBase: 14 },
  standard: { icon: 30, primaryGap: 1,   actionsGap: 2.5, appSwitcherMargin: 5, sidePadding: 9,  separatorWidth: 1, textBase: 15 },
  spacious: { icon: 34, primaryGap: 1,   actionsGap: 3,   appSwitcherMargin: 6, sidePadding: 10, separatorWidth: 1, textBase: 16 },
}

/**
 * Oxy V2 基础尺寸（与 oxy-config.ts OXY_BASE_VALUES 同步）。
 * window-size.ts 是纯函数模块，不依赖 src/lib/，因此在此复制基础值。
 */
const OXY_V2_BASE = {
  icon: 30,
  titlebarH: 46,
  textBase: 16,
  spaceUnit: 5,
} as const

/**
 * Oxy V2 属性调节器（与 oxy-config.ts OXY_ADJUSTERS 同步）。
 */
function applyAdjusterV2(scale: number, min: number | null, max: number | null): number {
  if (min !== null && scale < min) return min
  if (max !== null && scale > max) return max
  return scale
}

/** textBase 绝对下限（与 oxy-config.ts OXY_TEXT_FLOOR 同步） */
const OXY_V2_TEXT_FLOOR = 12

/**
 * 从连续 scale 计算窗口尺寸配置（替代离散 OXY_SCALE_CONFIG 查表）。
 * 使用与 oxy-layout-engine.ts 相同的基础值 × scale × adjuster 公式。
 */
export function getOxyScaleConfigByScale(scale: number) {
  const iconScale = applyAdjusterV2(scale, 0.95, 1.08)
  const textScale = applyAdjusterV2(scale, 1.0, 1.05)
  const icon = Math.round(OXY_V2_BASE.icon * scale * iconScale)
  const textBase = Math.max(OXY_V2_TEXT_FLOOR, Math.round(OXY_V2_BASE.textBase * scale * textScale))
  const u = Math.max(3, Math.round(OXY_V2_BASE.spaceUnit * scale))
  return {
    icon,
    primaryGap: Math.max(1, Math.round(u * 0.25)),
    actionsGap: Math.max(2, Math.round(u * 0.5 * 10) / 10),
    appSwitcherMargin: u,
    sidePadding: Math.round(u * 2),
    separatorWidth: 1,
    textBase,
  }
}

/**
 * 将连续 scale 映射到 OxyScale 档位（信息性）。
 */
export function scaleToOxyScale(scale: number): OxyScale {
  if (scale < 0.93) return 'compact'
  if (scale < 1.05) return 'standard'
  return 'spacious'
}

/**
 * 计算 Oxy 模式下主窗口的最小宽度。
 * 逻辑与 calculateMainWindowMinWidth 一致，但使用 Oxy 三档尺寸常量。
 */
export function calculateOxyMainWindowMinWidth(
  oxyScale: OxyScale,
  visibleButtons?: TopBarButtonGroup[],
  titleText?: string,
): number {
  const cfg = OXY_SCALE_CONFIG[oxyScale]
  const buttons = visibleButtons ?? (['uaToggle', 'navBack', 'navForward', 'navHome', 'themeToggle', 'pinToggle'] as TopBarButtonGroup[])
  const title = titleText ?? '工百窗'

  const hasUa = buttons.includes('uaToggle')
  const hasNavBack = buttons.includes('navBack')
  const hasNavForward = buttons.includes('navForward')
  const hasNavHome = buttons.includes('navHome')
  const hasTheme = buttons.includes('themeToggle')
  const hasPin = buttons.includes('pinToggle')
  const hasNavGroup = hasNavBack || hasNavForward

  const alwaysVisibleIcons = 6
  const optionalIcons =
    (hasUa ? 1 : 0) + (hasNavBack ? 1 : 0) + (hasNavForward ? 1 : 0) +
    (hasNavHome ? 1 : 0) + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const iconCount = alwaysVisibleIcons + optionalIcons

  const primaryElementCount = 4 + (hasUa ? 1 : 0) + (hasNavGroup ? 1 : 0) + (hasNavHome ? 1 : 0)
  const primaryGapCount = Math.max(0, primaryElementCount - 1)

  const actionsElementCount = 5 + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const actionsGapCount = Math.max(0, actionsElementCount - 1)

  const navGroupExtra = hasNavGroup
    ? cfg.actionsGap + (hasNavBack && hasNavForward ? cfg.primaryGap : 0)
    : 0

  const separatorTotal = cfg.separatorWidth + 2 * cfg.actionsGap
  const paddingTotal = 2 * cfg.sidePadding

  const titleWidth = estimateTextWidth(title, cfg.textBase)
  const dragRegionWidth = Math.max(DRAG_REGION_MIN_FLOOR, titleWidth * 2)

  const total =
    paddingTotal
    + cfg.appSwitcherMargin
    + iconCount * cfg.icon
    + primaryGapCount * cfg.primaryGap
    + navGroupExtra
    + dragRegionWidth
    + actionsGapCount * cfg.actionsGap
    + separatorTotal

  return Math.ceil(total / 10) * 10
}

/**
 * V2: 从连续 scale 计算主窗口最小宽度。
 * 替代 calculateOxyMainWindowMinWidth，使用 getOxyScaleConfigByScale。
 */
export function calculateOxyMainWindowMinWidthByScale(
  scale: number,
  visibleButtons?: TopBarButtonGroup[],
  titleText?: string,
): number {
  const cfg = getOxyScaleConfigByScale(scale)
  const buttons = visibleButtons ?? (['uaToggle', 'navBack', 'navForward', 'navHome', 'themeToggle', 'pinToggle'] as TopBarButtonGroup[])
  const title = titleText ?? '工百窗'

  const hasUa = buttons.includes('uaToggle')
  const hasNavBack = buttons.includes('navBack')
  const hasNavForward = buttons.includes('navForward')
  const hasNavHome = buttons.includes('navHome')
  const hasTheme = buttons.includes('themeToggle')
  const hasPin = buttons.includes('pinToggle')
  const hasNavGroup = hasNavBack || hasNavForward

  const alwaysVisibleIcons = 6
  const optionalIcons =
    (hasUa ? 1 : 0) + (hasNavBack ? 1 : 0) + (hasNavForward ? 1 : 0) +
    (hasNavHome ? 1 : 0) + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const iconCount = alwaysVisibleIcons + optionalIcons

  const primaryElementCount = 4 + (hasUa ? 1 : 0) + (hasNavGroup ? 1 : 0) + (hasNavHome ? 1 : 0)
  const primaryGapCount = Math.max(0, primaryElementCount - 1)

  const actionsElementCount = 5 + (hasTheme ? 1 : 0) + (hasPin ? 1 : 0)
  const actionsGapCount = Math.max(0, actionsElementCount - 1)

  const navGroupExtra = hasNavGroup
    ? cfg.actionsGap + (hasNavBack && hasNavForward ? cfg.primaryGap : 0)
    : 0

  const separatorTotal = cfg.separatorWidth + 2 * cfg.actionsGap
  const paddingTotal = 2 * cfg.sidePadding

  const titleWidth = estimateTextWidth(title, cfg.textBase)
  const dragRegionWidth = Math.max(DRAG_REGION_MIN_FLOOR, titleWidth * 2)

  const total =
    paddingTotal
    + cfg.appSwitcherMargin
    + iconCount * cfg.icon
    + primaryGapCount * cfg.primaryGap
    + navGroupExtra
    + dragRegionWidth
    + actionsGapCount * cfg.actionsGap
    + separatorTotal

  return Math.ceil(total / 10) * 10
}

/**
 * V2: 从连续 scale 计算 ChatView 窗口最小宽度。
 */
export function calculateOxyChatWindowMinWidthByScale(scale: number): number {
  const cfg = getOxyScaleConfigByScale(scale)
  const elementCount = 17
  const gapCount = 7
  const titleText = '自定义对话'
  const titleScaleFactor = 1.2
  const baseRedundancy = 80
  const fontPixelPerChar = 12

  const elementsWidth = elementCount * cfg.icon
  const gapsWidth = gapCount * cfg.primaryGap
  const titleWidth = titleText.length * fontPixelPerChar * titleScaleFactor
  const total = elementsWidth + gapsWidth + titleWidth + baseRedundancy
  return Math.ceil(total / 10) * 10
}

/**
 * V2: 从连续 scale 计算进阶面板最小宽度。
 */
export function calculateOxyAdvancedPanelMinWidthByScale(scale: number): number {
  const cfg = getOxyScaleConfigByScale(scale)
  const elementCount = 7
  const gapCount = 6
  const titleText = '进阶面板'
  const titleScaleFactor = 1.2
  const baseRedundancy = 32
  const fontPixelPerChar = 12

  const elementsWidth = elementCount * cfg.icon
  const gapsWidth = gapCount * cfg.primaryGap
  const titleWidth = titleText.length * fontPixelPerChar * titleScaleFactor
  const total = elementsWidth + gapsWidth + titleWidth + baseRedundancy
  return Math.ceil(total / 10) * 10
}

