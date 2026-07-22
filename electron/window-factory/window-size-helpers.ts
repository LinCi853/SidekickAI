// electron/window-factory/window-size-helpers.ts — 窗口最小尺寸动态计算
//
// 主进程专用：在共享纯函数（electron/shared/window-size.ts）基础上，
// 额外提供从 electron-store 读取 UI 比例的 getUiScaleFromSettings 包装。
//
// 渲染层应直接 import 共享模块（electron/shared/window-size.ts），
// 不要 import 本文件（依赖 electron-store 无法在渲染层运行）。

import { getAppSettings } from '../store/app-settings-store.js'
import type { UiScale } from '../shared/window-size.js'

// 重新导出共享纯函数与常量，方便主进程调用方单一 import 来源
export {
  UI_SCALE_CONFIG,
  calculateMinWidthByElements,
  calculateMainWindowMinWidth,
  calculateChatWindowMinWidth,
  calculateAiAppWindowMinWidth,
  MAIN_WINDOW_MIN_HEIGHT,
  CHAT_WINDOW_MIN_HEIGHT,
  AI_APP_WINDOW_MIN_HEIGHT,
} from '../shared/window-size.js'
export type { UiScale, MinWidthOptions } from '../shared/window-size.js'

/**
 * 从应用设置读取 UI 比例（默认 medium）。
 * 用于窗口创建时确定当前 UI 比例档位。
 */
export function getUiScaleFromSettings(): UiScale {
  try {
    const settings = getAppSettings()
    return settings.uiScale ?? 'medium'
  } catch {
    return 'medium'
  }
}
