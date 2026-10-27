// shared/background-policy.ts — 后台释放与窗口退役时长（纯常量/纯函数，主进程与渲染层共用）
//
// 产品约束：清理不得妨碍正常使用。切走看一眼文档、在其它程序里工作一会儿，
// 回来时窗口与页面都应还在。退役秒数对齐社区版 hostWindowCloseSeconds，
// 浏览器 / 独立 AI 网页窗按产品要求比社区版（300s）再放长。
//
// 低内存模式分档：下列 RETIRE_* / 后台释放基准是「打开低内存模式」的较紧档；
// 未打开（默认）时窗口退役 ×2、后台次窗口释放回到 30 分钟。

const MINUTE_MS = 60_000

/** 主窗/浏览器窗最小化或隐藏后，多久把全部标签（含激活页）换出 */
export const HIDDEN_RELEASE_DELAY_MS = 10 * MINUTE_MS

/** 应用整体无焦点后评估关闭次窗口：低内存模式 15 分钟，默认 30 分钟 */
export const BACKGROUND_RELEASE_DELAY_MS = 15 * MINUTE_MS
export const BACKGROUND_RELEASE_DELAY_DEFAULT_MS = 30 * MINUTE_MS

/** 全部窗口进入后台后的轻释放（仅工作集裁剪，不关窗不卸页）：低内存模式 30 秒，默认 60 秒 */
export const ALL_BACKGROUND_TRIM_DELAY_MS = 30 * 1000
export const ALL_BACKGROUND_TRIM_DELAY_DEFAULT_MS = 60 * 1000

// —— 窗口退役（对齐社区版 docs/specs/background-window-retirement.md）——
// 以下为低内存模式档。历史/提示词等轻量面板 30s；设置等默认 60s；主窗 180s；
// 对话/数据迁移/引导 300s；浏览器与独立 AI 网页窗更长（600s）。默认模式整体 ×2。
const RETIRE_LIGHTWEIGHT_SECONDS = 30
const RETIRE_DEFAULT_SECONDS = 60
const RETIRE_MAIN_SECONDS = 180
const RETIRE_CONTENT_SECONDS = 300
/** 浏览器 / Profile 壳 / 独立 AI 网页：比社区版 300s 更长 */
const RETIRE_BROWSER_SECONDS = 600

/** 兜底：未归类窗口按设置档（低内存模式档） */
export const WINDOW_RETIREMENT_SECONDS = RETIRE_DEFAULT_SECONDS

/** 浏览器窗 / Profile 壳窗固定用浏览器档（低内存模式档） */
export const BROWSER_WINDOW_RETIREMENT_SECONDS = RETIRE_BROWSER_SECONDS

/**
 * 按窗口类型取退役秒数（社区版 hostWindowCloseSeconds 同款映射）。
 * 低内存模式用基准秒数；未打开时 ×2，窗口留在后台更久。
 */
export function windowRetirementSeconds(windowId: string, lowMemoryMode = false): number {
  let base: number
  if (['history', 'prompts', 'history-download'].includes(windowId)) {
    base = RETIRE_LIGHTWEIGHT_SECONDS
  } else if (windowId === 'main') {
    base = RETIRE_MAIN_SECONDS
  } else if (
    windowId === 'onboarding' ||
    windowId === 'data-export' ||
    windowId.startsWith('chat')
  ) {
    base = RETIRE_CONTENT_SECONDS
  } else if (
    windowId.startsWith('browser') ||
    windowId.startsWith('standalone') ||
    (windowId.startsWith('ai-app') && !windowId.startsWith('ai-app-editor'))
  ) {
    // 独立 AI 网页 / 浏览器 / Profile 壳（含 ai-app 运行窗，不含编辑器）
    base = RETIRE_BROWSER_SECONDS
  } else {
    // 设置、模块管理、快捷键编辑、进阶面板、AI 应用编辑器等
    base = RETIRE_DEFAULT_SECONDS
  }
  return lowMemoryMode ? base : base * 2
}

/** 浏览器 / Profile 壳窗退役秒数（低内存模式档为 BROWSER_WINDOW_RETIREMENT_SECONDS） */
export function browserWindowRetirementSeconds(lowMemoryMode = false): number {
  return lowMemoryMode ? RETIRE_BROWSER_SECONDS : RETIRE_BROWSER_SECONDS * 2
}

/** 纯后台次窗口释放延迟：低内存模式 15 分钟，默认 30 分钟 */
export function backgroundReleaseDelayMs(lowMemoryMode = false): number {
  return lowMemoryMode ? BACKGROUND_RELEASE_DELAY_MS : BACKGROUND_RELEASE_DELAY_DEFAULT_MS
}

/** 全部窗口进入后台后的裁剪延迟：低内存模式 30 秒，默认 60 秒 */
export function allBackgroundTrimDelayMs(lowMemoryMode = false): number {
  return lowMemoryMode ? ALL_BACKGROUND_TRIM_DELAY_MS : ALL_BACKGROUND_TRIM_DELAY_DEFAULT_MS
}
