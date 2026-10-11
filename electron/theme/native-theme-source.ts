// electron/theme/native-theme-source.ts — 应用主题到 Chromium 配色方案（nativeTheme.themeSource）
//
// 壳 UI 的主题模式（useThemeStore，渲染层 localStorage）与 webview 内 AI 应用
// 读取的 prefers-color-scheme 是两条独立通路：后者只认主进程的
// nativeTheme.themeSource（缺省 'system'，跟随操作系统）。
// 本模块把壳的主题模式映射过去，保证内嵌 AI 应用以应用内主题为准：
//   - Oxy Design System 强制亮色：uiVersion='oxy' 时一律映射为 'light'
//   - 其余模式（light/dark/system）与 Chromium themeSource 一一同名直映

import { nativeTheme } from 'electron'

export type ThemeMode = 'light' | 'dark' | 'system'
export type UiVersion = 'classic' | 'oxy'

const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** 计算有效主题模式：Oxy 强制亮色，其余按所选模式直映；意外值回退 system（Chromium 缺省） */
export function resolveEffectiveThemeMode(uiVersion: UiVersion, theme: ThemeMode): ThemeMode {
  if (uiVersion === 'oxy') return 'light'
  return THEME_MODES.includes(theme) ? theme : 'system'
}

/** 将主题模式写入 nativeTheme.themeSource（影响所有渲染层与 webview 的 prefers-color-scheme） */
export function setNativeThemeSource(mode: ThemeMode): void {
  nativeTheme.themeSource = mode
}

/** 处理渲染层广播的 UI 版本/主题变更：应用并返回有效模式（供调用方按需持久化） */
export function applyUiThemeBroadcast(uiVersion: UiVersion, theme: ThemeMode): ThemeMode {
  const effective = resolveEffectiveThemeMode(uiVersion, theme)
  setNativeThemeSource(effective)
  return effective
}
