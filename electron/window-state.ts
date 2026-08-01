// electron/window-state.ts — 全局可变窗口状态集中托管
//
// 从 main.ts 抽离的窗口相关可变状态。main.ts 与 window-factory.ts 共同从此 import，
// 避免二者相互 import 造成循环依赖。
//
// 设计说明：
//   - 窗口引用（mainWindow / detachedWindows / historyWindow /
//     promptWindow / previewWindow / lastFocusedWin）原为 main.ts 顶层 let/const，
//     被 window-factory.ts 的窗口创建函数读写，故迁移至此共享对象。
//   - boundsSaveTimers：setupBoundsTracking 防抖定时器映射。
//   - windowManager：窗口创建函数需要 setupSession，原为 main.ts 顶层 let，
//     在 app.whenReady 中赋值；放入此处便于 window-factory.ts 访问，且避免在
//     window-factory.ts 内引入额外 setter。运行时仅在 whenReady 赋值后被读取，
//     读取处使用非空断言（!），与原逻辑等价（不会在未初始化时调用）。

import type { BrowserWindow } from 'electron'
import type { WindowManager } from './window/manager.js'

export const windowState = {
  // 主 UI 窗口（多标签）
  mainWindow: null as BrowserWindow | null,
  // 脱离窗口：windowId -> BrowserWindow
  detachedWindows: new Map<string, BrowserWindow>(),
  // 历史搜索独立窗口（单例）
  historyWindow: null as BrowserWindow | null,
  // 提示词库独立窗口（单例）
  promptWindow: null as BrowserWindow | null,
  // 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）
  advancedPanelWindow: null as BrowserWindow | null,
  // 引导独立窗口（单例，首次启动或「使用指南」入口）
  onboardingWindow: null as BrowserWindow | null,
  // 数据导出独立窗口（单例，细粒度选择导出内容 + 体积提示）
  dataExportWindow: null as BrowserWindow | null,
  // 设置独立窗口（单例，左导航+右内容布局）
  settingsWindow: null as BrowserWindow | null,
  // AI 应用编辑独立窗口（按 platformId 多例）：platformId -> BrowserWindow
  aiAppEditorWindows: new Map<string, BrowserWindow>(),
  // 后台语音录音指示器（Alt+V 录音时显示的 32x32 红点）
  previewWindow: null as BrowserWindow | null,
  // 最近聚焦的应用内窗口（置顶热键作用对象，回退到 mainWindow）
  lastFocusedWin: null as BrowserWindow | null,
  // 防抖保存 bounds 的定时器
  boundsSaveTimers: new Map<string, NodeJS.Timeout>(),
  // 窗口管理器（whenReady 后赋值，窗口创建函数读取）
  windowManager: null as WindowManager | null,
  // 是否启用托盘（启用后关闭主窗口不退出应用，托盘可恢复）
  trayEnabled: false,
  // --dev-tools 启动参数：新窗口创建后自动打开 DevTools（调试模式）
  autoOpenDevTools: false,
}
