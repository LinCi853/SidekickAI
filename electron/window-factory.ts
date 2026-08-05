// electron/window-factory.ts — 桶导出（barrel）
//
// 原文件（831 行）已按窗口类型物理拆分到 window-factory/ 子目录：
//   - helpers.ts           纯辅助函数 + 常量（setupBoundsTracking / loadRenderer /
//                          safeLogWindowTrace / getFormBounds / resolveUserAgent /
//                          findWindowIdByWin / attachWebviewPopupInterceptor 等）
//   - main-window.ts       createMainWindow
//   - standalone-window.ts createStandaloneWindow
//   - chat-window.ts       createChatWindow / createChatDetachedWindow /
//                          toggleChatDetachedWindows
//   - popup-windows.ts     showHistoryWindow / showPromptWindow / showAiAppEditorWindow
//
// 本文件保留为桶导出，使 main.ts 的 `from './window-factory.js'` import 路径
// 无需修改。仅 re-export 原 window-factory.ts 对外公开的 12 个函数，保持公共
// API 完全不变（setupBoundsTracking / safeLogWindowTrace 等仍为模块私有，不暴露）。
//
// 为什么不删除本文件改用 window-factory/index.ts？
//   main.ts 的 import 是 `from './window-factory.js'`（带 .js 扩展名）。在
//   TypeScript Bundler 模式与 Node.js ESM 解析中，`./window-factory.js` 通过
//   扩展名替换解析到 `./window-factory.ts`（本文件），而不会解析到
//   `./window-factory/index.ts`（目录解析仅对无扩展名 import 生效）。若删除
//   本文件，main.ts 的 import 会失败。保留本文件作为桶导出是最安全的方案，
//   同时 window-factory.ts（文件）与 window-factory/（目录）在文件系统上名称
//   不同，可以共存，且 .js 扩展名 import 优先解析到文件，无歧义。

export { getSenderWindow, loadRenderer, getFormBounds, findWindowIdByWin } from './window-factory/helpers.js'
export { createMainWindow } from './window-factory/main-window.js'
export { createStandaloneWindow } from './window-factory/standalone-window.js'
export { createBrowserWindow } from './window-factory/browser-window.js'
export { createChatWindow, createChatDetachedWindow } from './window-factory/chat-window.js'
export { showHistoryWindow, showPromptWindow, showAiAppEditorWindow, showDataExportWindow, showSettingsWindow } from './window-factory/popup-windows.js'
export {
  createAdvancedPanelWindow,
  openAdvancedPanelWindow,
  showAdvancedPanelWindow,
  focusAdvancedPanelWindow,
  toggleAdvancedPanelWindow,
} from './window-factory/advanced-panel-window.js'
export { showOnboardingWindow, setOnboardingLifecycleCallbacks } from './window-factory/onboarding-window.js'
export { showProcessCleanupWindow } from './window-factory/process-cleanup-window.js'
