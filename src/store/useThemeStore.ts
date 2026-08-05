/* =====================================================================
   store/useThemeStore.ts —— 应用级亮色/暗色主题状态
   纯渲染层实现：不依赖主进程 IPC，通过 <html> 的 class 与 data-theme
   属性切换 design-tokens.css 中已就绪的两套 token。
   持久化使用 localStorage（键名 ai-window-theme），安装后默认亮色。
   支持「跟随系统」：theme='system' 时监听 prefers-color-scheme 实时切换。
   ===================================================================== */

import { create } from 'zustand';
import { broadcastUiVersionChanged } from '../lib/electron-api';
import { OXY_STORAGE_KEY } from '../lib/oxy-design-system';

export type ThemeMode = 'light' | 'dark' | 'system';
/** 实际应用到 DOM 的解析后主题（system 会被解析为 light/dark） */
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ai-window-theme';

/** 将解析后主题应用到 DOM：<html> 的 class 与 data-theme 属性 */
function applyThemeToDOM(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (resolved === 'light') {
    html.classList.remove('dark');
    html.setAttribute('data-theme', 'light');
  } else {
    html.classList.add('dark');
    html.setAttribute('data-theme', 'dark');
  }
}

/** 读取系统当前配色偏好 */
function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 把 ThemeMode 解析为实际主题 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? readSystemTheme() : mode;
}

/** 从 localStorage 读取主题模式，失败或未设置时返回默认 'light'（安装后默认亮色） */
function readThemeMode(): ThemeMode {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
    return 'light';
  } catch {
    return 'light';
  }
}

/** 写入 localStorage，失败时静默忽略 */
function persistThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 忽略隐私模式或配额异常 */
  }
}

export interface ThemeState {
  /** 当前主题模式，默认 'light'（安装后亮色） */
  theme: ThemeMode;
  /** 解析后的实际主题（system 时跟随系统） */
  resolved: ResolvedTheme;
  /** 设置主题模式：应用 DOM + 持久化 + 更新状态 */
  setTheme: (mode: ThemeMode) => void;
  /** 在 light / dark 之间快速切换（不影响 system 模式） */
  toggleTheme: () => void;
  /** 重新读取 localStorage 并同步 DOM（幂等，供 main.tsx 调用） */
  initTheme: () => void;
}

/** 系统配色变化监听器（仅 system 模式生效） */
let systemMql: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function attachSystemListener(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  if (systemMql) return;
  systemMql = window.matchMedia('(prefers-color-scheme: dark)');
  systemListener = () => {
    const st = useThemeStore.getState();
    if (st.theme === 'system') {
      const resolved = readSystemTheme();
      applyThemeToDOM(resolved);
      useThemeStore.setState({ resolved });
    }
  };
  systemMql.addEventListener('change', systemListener);
}

/** 模块加载时立即读取并同步 DOM，避免 React 渲染前的闪烁 */
const initialMode = readThemeMode();
const initialResolved = resolveTheme(initialMode);
applyThemeToDOM(initialResolved);
if (initialMode === 'system') attachSystemListener();

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialMode,
  resolved: initialResolved,

  setTheme: (mode) => {
    const resolved = resolveTheme(mode);
    applyThemeToDOM(resolved);
    persistThemeMode(mode);
    // system 模式需要监听系统变化；非 system 模式无需监听
    if (mode === 'system') {
      attachSystemListener();
    }
    set({ theme: mode, resolved });
    // 广播主题变更到所有窗口（跨窗口同步主题模式）
    // 从 localStorage 读取 UI 版本（避免循环依赖 useUiVersionStore）
    try {
      const uiVersion = (localStorage.getItem(OXY_STORAGE_KEY) === 'classic') ? 'classic' as const : 'oxy' as const;
      broadcastUiVersionChanged({ uiVersion, theme: mode });
    } catch { /* 非 Electron 环境忽略 */ }
  },

  toggleTheme: () => {
    // 在 light / dark 间切换；当前为 system 时切到 light
    const cur = get().resolved;
    get().setTheme(cur === 'dark' ? 'light' : 'dark');
  },

  initTheme: () => {
    const mode = readThemeMode();
    const resolved = resolveTheme(mode);
    applyThemeToDOM(resolved);
    if (mode === 'system') attachSystemListener();
    set({ theme: mode, resolved });
  },
}));
