/* =====================================================================
   Oxy Design System V2 — 集中控制器
   统一管理 Oxy 激活/停用时的所有副作用：
   - CSS 变量（布局 + 颜色）注入 :root
   - 主题强制亮色
   - 连续 DPI scale 自动计算
   - Auto/Manual 覆盖存储
   - 标签切换时全局品牌色跟随当前 app 的 themeColor
   - resize 监听器
   所有切换逻辑集中于此，方便后续新增和统一查看。
   ===================================================================== */

import { generateFullTheme, relativeLuminance } from './oxy-color-engine';
import {
  type OxyLayout,
  computeLayout,
  layoutToCssVars,
} from './oxy-layout-engine';
import {
  OXY_STORAGE_KEYS,
  computeDpiScale,
} from './oxy-config';
import {
  clearAllOverrides,
  resolveParam,
} from './oxy-override-store';

/* ===== 常量 ===== */
export const OXY_STORAGE_KEY = OXY_STORAGE_KEYS.uiVersion;
/** Oxy 默认品牌色（靛蓝） */
const OXY_DEFAULT_COLOR = '#6366f1';

/** 界面版本类型（与 useUiVersionStore 共享） */
export type UiVersion = 'classic' | 'oxy';

/** 保留旧类型别名，兼容已有引用 */
export type UiScale = 'small' | 'medium' | 'large';

/* ===== 状态缓存 ===== */

let currentLayout: OxyLayout | null = null;

/* ===== 分辨率 → UI 比例（旧接口兼容） ===== */

/**
 * @deprecated Oxy V2 使用连续 scale，不再返回离散 UiScale。
 */
export function detectUiScale(): UiScale {
  if (typeof window === 'undefined') return 'medium';
  const h = window.screen.height;
  if (h <= 1080) return 'small';
  if (h <= 1440) return 'medium';
  return 'large';
}

/* ===== DOM 操作 ===== */

function applyUiVersion(version: UiVersion): void {
  document.documentElement.setAttribute('data-ui-version', version);
}

function applyTheme(mode: 'light'): void {
  const html = document.documentElement;
  html.classList.remove('dark');
  html.setAttribute('data-theme', 'light');
}

/** 将 CSS 变量键值对字典注入 :root */
function injectCssVars(vars: Record<string, string>): void {
  const root = document.documentElement;
  for (const [key, val] of Object.entries(vars)) {
    root.style.setProperty(key, val);
  }
}

/** 移除 :root 上由 Oxy 注入的 CSS 变量 */
function removeOxyCssVars(): void {
  const root = document.documentElement;
  const layoutKeys = [
    '--titlebar-h', '--tabs-h', '--titlebar-icon', '--icon-svg', '--icon-svg-sm',
    '--toggle-w', '--toggle-h', '--btn-h', '--toggle-pad', '--toggle-knob',
    '--sidebar-w', '--chat-input-min-h', '--app-grid-item-w', '--expanded-btn-w',
    '--panel-min-w', '--panel-max-w', '--page-margin-max', '--sidebar-max-w',
    '--window-min-w', '--window-min-h',
  ];
  const colorKeys = [
    '--brand-50', '--brand-100', '--brand-200', '--brand-300', '--brand-400',
    '--brand-500', '--brand-600', '--brand-700', '--brand-800', '--brand-900',
    '--primary', '--primary-foreground', '--ring',
    '--success', '--warning', '--destructive',
    '--accent-bright', '--accent-bright-foreground', '--accent-light', '--accent-light-foreground', '--accent-dim',
    '--accent-90', '--accent-75', '--accent-50', '--accent-25', '--accent-10', '--accent-05',
    '--accent',
  ];
  const spaceKeys = ['0-25','0-5','0-75','1','1-25','1-5','1-75','2','2-25','2-5','2-75','3','3-5','4','4-5','5','5-5','6','8','10','12','16','20'];
  const textKeys = ['xs','sm','base','md','lg','xl','2xl','3xl','4xl','5xl'];
  const radiusKeys = ['2xs','xs','sm','md','lg','xl','2xl','full'];

  for (const key of [...layoutKeys, ...colorKeys]) {
    root.style.removeProperty(key);
  }
  for (const s of spaceKeys) root.style.removeProperty(`--space-${s}`);
  for (const t of textKeys) root.style.removeProperty(`--text-${t}`);
  for (const r of radiusKeys) root.style.removeProperty(`--radius-${r}`);
}

/* ===== 布局计算 + 注入 ===== */

/**
 * 获取屏幕逻辑尺寸。
 * window.screen.width/height 已是逻辑像素（物理像素 / scaleFactor）。
 */
function getScreenSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1920, h: 1080 };
  return { w: window.screen.width, h: window.screen.height };
}

/** 计算当前屏幕的 Oxy 布局并注入 CSS 变量 */
function applyOxyLayout(): OxyLayout {
  const { w, h } = getScreenSize();
  // 用户手动覆盖的 uiScale（如果存在）
  const autoScale = computeDpiScale(w, h);
  const scale = resolveParam('uiScale', autoScale);
  const layout = computeLayout(scale, w, h);
  currentLayout = layout;

  injectCssVars(layoutToCssVars(layout));
  document.documentElement.setAttribute('data-oxy-scale', layout.uiScale);

  return layout;
}

/* ===== 颜色注入 ===== */

/**
 * 将 CSS rgb() 字符串（如 'rgb(244, 244, 245)'）转为 hex。
 */
function rgbToHex(rgb: string): string | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)/i.exec(rgb);
  if (!m) return null;
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(Number(m[1]))}${toHex(Number(m[2]))}${toHex(Number(m[3]))}`;
}

/**
 * 获取当前 :root 上 --background 的实际颜色值（hex）。
 * Oxy 模式强制亮色背景，如果读取失败或得到深色值，使用默认浅灰。
 */
function getBackgroundHex(): string {
  if (typeof window === 'undefined') return '#f4f4f5';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  let hex = '#f4f4f5';
  if (!raw) return hex;
  // 可能是 hex 或 rgb/rgba
  if (raw.startsWith('#')) hex = raw;
  else if (raw.startsWith('rgb')) {
    const parsed = rgbToHex(raw);
    if (parsed) hex = parsed;
  }
  // Oxy 强制亮色：如果背景不是明显浅色，回退到 base.css 的 --background
  if (relativeLuminance(hex) < 0.5) return '#f6f7f9';
  return hex;
}

/**
 * 将指定颜色的完整主题注入 :root。
 * 切换标签时调用，实现全局品牌色跟随当前 app。
 * 自动读取当前 --background 保证主题色与背景对比度。
 */
/** Oxy 亮色模式固定背景色（与 base.css 一致），避免 CSS 加载时机导致读取错误 */
const OXY_LIGHT_BACKGROUND = '#f6f7f9';

export function applyAppTheme(hex: string): void {
  const bgHex = OXY_LIGHT_BACKGROUND;
  const vars = generateFullTheme(hex, bgHex);
  // DEBUG: 验证主题色生成结果
  // eslint-disable-next-line no-console
  console.log('[Oxy] applyAppTheme hex=' + hex + ' bg=' + bgHex + ' primary=' + vars['--primary'] + ' fg=' + vars['--primary-foreground'] + ' accent=' + vars['--accent-bright']);
  injectCssVars(vars);
  try {
    localStorage.setItem(OXY_STORAGE_KEYS.appColor, hex);
  } catch { /* 忽略 */ }
}

/* ===== 监听器管理 ===== */

let resizeListener: (() => void) | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function attachResizeListener(): void {
  if (typeof window === 'undefined' || resizeListener) return;
  resizeListener = () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyOxyLayout();
    }, 300);
  };
  window.addEventListener('resize', resizeListener);
}

function detachResizeListener(): void {
  if (!resizeListener) return;
  window.removeEventListener('resize', resizeListener);
  resizeListener = null;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
}

/* ===== 存储辅助 ===== */

function persistVersion(version: UiVersion): void {
  try {
    localStorage.setItem(OXY_STORAGE_KEYS.uiVersion, version);
  } catch { /* 忽略 */ }
}

/** 保存用户手动选择的 UI 比例（仅 Oxy 关闭时使用） */
export function persistUserUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(OXY_STORAGE_KEYS.userUiScale, scale);
  } catch { /* 忽略 */ }
}

/** 读取用户之前手动选择的 UI 比例，无记录时返回 'medium' */
export function readUserUiScale(): UiScale {
  try {
    const v = localStorage.getItem(OXY_STORAGE_KEYS.userUiScale);
    if (v === 'small' || v === 'medium' || v === 'large') return v;
    return 'medium';
  } catch {
    return 'medium';
  }
}

/* ===== 公开 API ===== */

/**
 * 获取当前 Oxy 布局计算结果（供窗口尺寸计算使用）。
 * Oxy 未激活时返回 null。
 */
export function getOxyLayout(): OxyLayout | null {
  return currentLayout;
}

/**
 * 激活 Oxy Design System V2。
 * 所有联动副作用集中在此方法中。
 */
export function activateOxy(): void {
  // 1. 清除所有 manual 覆盖，全部回到 auto
  clearAllOverrides();

  // 2. DOM：设置界面版本为 oxy
  applyUiVersion('oxy');

  // 3. 标记 Oxy 激活
  document.documentElement.setAttribute('data-oxy', 'true');

  // 4. 主题：强制亮色模式
  applyTheme('light');

  // 5. 布局：根据屏幕分辨率计算连续 scale 并注入 CSS 变量
  applyOxyLayout();

  // 6. 颜色：恢复上次激活 app 的主题色（或默认靛蓝）
  let savedColor = OXY_DEFAULT_COLOR;
  try {
    const c = localStorage.getItem(OXY_STORAGE_KEYS.appColor);
    if (c) savedColor = c;
  } catch { /* 忽略 */ }
  applyAppTheme(savedColor);

  // 7. 监听：窗口大小变化时重新计算布局
  attachResizeListener();

  // 8. 持久化
  persistVersion('oxy');

  // --- 后续新增联动逻辑请在此处添加 ---
}

/**
 * 停用 Oxy Design System，恢复到经典版。
 */
export function deactivateOxy(): void {
  // 1. DOM：设置界面版本为 classic
  applyUiVersion('classic');

  // 2. 移除 Oxy 标记
  document.documentElement.removeAttribute('data-oxy');
  document.documentElement.removeAttribute('data-oxy-scale');

  // 3. 移除 Oxy 注入的 CSS 变量
  removeOxyCssVars();

  // 4. 恢复用户之前的手动 UI 比例
  const scale = readUserUiScale();
  document.documentElement.setAttribute('data-ui-scale', scale);

  // 5. 恢复用户保存的主题（OXY 激活时强制亮色，停用后需还原）
  const THEME_KEY = 'ai-window-theme';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') {
      const html = document.documentElement;
      if (saved === 'system') {
        const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        html.classList.toggle('dark', !!sysDark);
        html.setAttribute('data-theme', sysDark ? 'dark' : 'light');
      } else if (saved === 'dark') {
        html.classList.add('dark');
        html.setAttribute('data-theme', 'dark');
      } else {
        html.classList.remove('dark');
        html.setAttribute('data-theme', 'light');
      }
    }
  } catch { /* 忽略 */ }

  // 6. 停止分辨率监听
  detachResizeListener();

  // 7. 清除布局缓存
  currentLayout = null;

  // 8. 持久化
  persistVersion('classic');

  // --- 后续新增联动逻辑请在此处添加 ---
}

/**
 * 应用 Oxy 初始化（页面加载时调用，幂等）。
 * 如果已激活则重新应用所有副作用。
 */
export function initOxy(): void {
  try {
    const v = localStorage.getItem(OXY_STORAGE_KEYS.uiVersion);
    if (v === 'classic') {
      applyUiVersion('classic');
      document.documentElement.setAttribute('data-ui-scale', readUserUiScale());
    } else {
      activateOxy();
    }
  } catch {
    activateOxy();
  }
}
