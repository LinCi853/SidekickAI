/* =====================================================================
   lib/platform-detector.ts —— 运行环境检测（electron / mobile / web）
   ---------------------------------------------------------------------
   - Capacitor 原生平台（Android/iOS）→ 'mobile'
   - Electron 桌面环境            → 'electron'
   - 纯浏览器 / 未知环境            → 'web'
   检测在模块加载时一次性求值并缓存到 PLATFORM 常量，供同步分支使用。
   ===================================================================== */

/** 支持的运行平台标识 */
export type Platform = 'electron' | 'mobile' | 'web'

/**
 * 检测当前运行平台。
 * 检测顺序：Capacitor 原生 → Electron → Web。
 * Capacitor 在原生平台会注入 window.Capacitor 且 isNativePlatform() 返回 true；
 * Electron 通过 preload contextBridge 注入 window.electron。
 */
export function detectPlatform(): Platform {
  // Capacitor 原生平台（Android / iOS）
  if (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor !== 'undefined' &&
    (window as unknown as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor.isNativePlatform()
  ) {
    return 'mobile'
  }
  // Electron（preload 注入 window.electron）
  if (typeof window !== 'undefined' && typeof (window as unknown as { electron?: unknown }).electron !== 'undefined') {
    return 'electron'
  }
  return 'web'
}

/** 当前平台是否为 Electron 桌面端 */
export function isElectron(): boolean {
  return detectPlatform() === 'electron'
}

/** 当前平台是否为移动端（Capacitor 原生） */
export function isMobile(): boolean {
  return detectPlatform() === 'mobile'
}

/**
 * 平台常量 —— 模块加载时一次性求值。
 * 供同步代码分支使用（如 App.tsx 顶部平台分流），避免重复调用 detectPlatform()。
 */
export const PLATFORM: Platform = detectPlatform()
