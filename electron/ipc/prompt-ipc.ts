// electron/ipc/prompt-ipc.ts — 提示词库独立窗口相关 IPC 注册
//
// 包含：
//   - PROMPT_OPEN_WINDOW：打开提示词库独立窗口（单例，不遮挡主页面）
//   - PROMPT_INJECT_REQUEST：提示词注入请求（提示词库窗口 → 主进程 → 主窗口渲染，注入激活 webview）
//     主窗口渲染层通过 onPromptInjectRequest 监听，执行注入后通过 IPC 回传结果
//   - PROMPT_INJECT_RESULT：提示词注入结果回传（主窗口渲染 → 主进程 → 提示词库窗口渲染）
//     主窗口执行完注入后把 {success, platformName} 发回，主进程转发给提示词库窗口以显示 toast
//
// 在 app.whenReady 后由 main.ts 调用 registerPromptIpc(deps) 完成注册。

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS, type PromptTemplate } from '../shared/types.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface PromptIpcDeps {
  /** 显示提示词库独立窗口（单例） */
  showPromptWindow: () => void
  /** 获取主窗口（用于转发注入请求到主窗口渲染层） */
  getMainWindow: () => BrowserWindow | null
  /** 获取提示词库窗口（用于转发注入结果回提示词库窗口） */
  getPromptWindow: () => BrowserWindow | null
}

/** 注册提示词库窗口相关 IPC handler */
export function registerPromptIpc(deps: PromptIpcDeps): void {
  const { showPromptWindow, getMainWindow, getPromptWindow } = deps

  // ===== 提示词库独立窗口 IPC（单例，不遮挡主页面） =====
  ipcMain.handle(IPC_CHANNELS.PROMPT_OPEN_WINDOW, () => {
    showPromptWindow()
  })
  // 提示词注入请求：提示词库窗口 → 主进程 → 主窗口渲染（注入激活 webview）
  // 主窗口渲染层通过 onPromptInjectRequest 监听，执行注入后通过 IPC 回传结果
  // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
  ipcMain.handle(IPC_CHANNELS.PROMPT_INJECT_REQUEST, (_e, template: PromptTemplate) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 通知主窗口渲染层执行注入；结果通过 PROMPT_INJECT_RESULT 回传到提示词库窗口
    mainWindow.webContents.send(IPC_CHANNELS.PROMPT_INJECT_REQUEST, template)
  })
  // 提示词注入结果回传：主窗口渲染 → 主进程 → 提示词库窗口渲染
  // 主窗口执行完注入后把 {success, platformName} 发回，主进程转发给提示词库窗口以显示 toast
  ipcMain.on(IPC_CHANNELS.PROMPT_INJECT_RESULT, (_e, result: { success: boolean; platformName?: string }) => {
    const promptWindow = getPromptWindow()
    if (promptWindow && !promptWindow.isDestroyed()) {
      promptWindow.webContents.send(IPC_CHANNELS.PROMPT_INJECT_RESULT, result)
    }
  })
}
