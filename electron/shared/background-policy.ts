// shared/background-policy.ts — 后台释放与窗口退役时长（纯常量，主进程与渲染层共用）
//
// 产品约束：清理不得妨碍正常使用。切走看一眼文档、在其它程序里工作一会儿，
// 回来时窗口与页面都应还在。退役秒数对齐社区版 hostWindowCloseSeconds，
// 浏览器 / 独立 AI 网页窗按产品要求比社区版（300s）再放长。

const MINUTE_MS = 60_000

/** 主窗/浏览器窗最小化或隐藏后，多久把全部标签（含激活页）换出 */
export const HIDDEN_RELEASE_DELAY_MS = 10 * MINUTE_MS

/** 应用整体无焦点后，主进程多久评估关闭已隐藏/最小化的次窗口 */
export const BACKGROUND_RELEASE_DELAY_MS = 30 * MINUTE_MS

// —— 窗口退役（对齐社区版 docs/specs/background-window-retirement.md）——
// 历史/提示词等轻量面板 30s；设置等默认 60s；主窗 180s；
// 对话/数据迁移/引导 300s；浏览器与独立 AI 网页窗更长（600s）。
const RETIRE_LIGHTWEIGHT_SECONDS = 30
const RETIRE_DEFAULT_SECONDS = 60
const RETIRE_MAIN_SECONDS = 180
const RETIRE_CONTENT_SECONDS = 300
/** 浏览器 / Profile 壳 / 独立 AI 网页：比社区版 300s 更长 */
const RETIRE_BROWSER_SECONDS = 600

/** 兜底：未归类窗口按设置档 */
export const WINDOW_RETIREMENT_SECONDS = RETIRE_DEFAULT_SECONDS

/** 浏览器窗 / Profile 壳窗固定用浏览器档 */
export const BROWSER_WINDOW_RETIREMENT_SECONDS = RETIRE_BROWSER_SECONDS

/**
 * 按窗口类型取退役秒数（社区版 hostWindowCloseSeconds 同款映射）。
 * 浏览器与 AI 网页窗用 RETIRE_BROWSER_SECONDS。
 */
export function windowRetirementSeconds(windowId: string): number {
  if (['history', 'prompts', 'history-download'].includes(windowId)) {
    return RETIRE_LIGHTWEIGHT_SECONDS
  }
  if (windowId === 'main') return RETIRE_MAIN_SECONDS
  if (
    windowId === 'onboarding'
    || windowId === 'data-export'
    || windowId.startsWith('chat')
  ) {
    return RETIRE_CONTENT_SECONDS
  }
  // 独立 AI 网页 / 浏览器 / Profile 壳（含 ai-app 运行窗，不含编辑器）
  if (windowId.startsWith('browser') || windowId.startsWith('standalone')) {
    return RETIRE_BROWSER_SECONDS
  }
  if (windowId.startsWith('ai-app') && !windowId.startsWith('ai-app-editor')) {
    return RETIRE_BROWSER_SECONDS
  }
  // 设置、模块管理、快捷键编辑、进阶面板、AI 应用编辑器等
  return RETIRE_DEFAULT_SECONDS
}
