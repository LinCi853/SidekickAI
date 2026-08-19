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
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS, type PromptTemplate } from '../shared/types.js'
import type { EffectScope } from '../modules/effect-scope.js'

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface PromptIpcDeps {
  /** 显示提示词库独立窗口（单例） */
  showPromptWindow: () => void
  /** 获取主窗口（用于转发注入请求到主窗口渲染层） */
  getMainWindow: () => BrowserWindow | null
  /** 获取提示词库窗口（用于转发注入结果回提示词库窗口） */
  getPromptWindow: () => BrowserWindow | null
}

/**
 * 注册提示词库窗口相关 IPC handler。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerPromptIpc(deps: PromptIpcDeps, scope?: EffectScope): void {
  const { showPromptWindow, getMainWindow, getPromptWindow } = deps

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== 提示词库独立窗口 IPC（单例，不遮挡主页面） =====
  handle(IPC_CHANNELS.PROMPT_OPEN_WINDOW, () => {
    showPromptWindow()
  })
  // 提示词注入请求：提示词库窗口 → 主进程 → 主窗口渲染（注入激活 webview）
  // 主窗口渲染层通过 onPromptInjectRequest 监听，执行注入后通过 IPC 回传结果
  // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
  handle(IPC_CHANNELS.PROMPT_INJECT_REQUEST, (_e: unknown, template: PromptTemplate) => {
    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 通知主窗口渲染层执行注入；结果通过 PROMPT_INJECT_RESULT 回传到提示词库窗口
    mainWindow.webContents.send(IPC_CHANNELS.PROMPT_INJECT_REQUEST, template)
  })
  // 提示词注入结果回传：主窗口渲染 → 主进程 → 提示词库窗口渲染
  // 主窗口执行完注入后把 {success, platformName} 发回，主进程转发给提示词库窗口以显示 toast
  // 注意：这里使用 ipcMain.on 而非 handle，因为不需要返回值
  if (scope) {
    scope.ipcOn(IPC_CHANNELS.PROMPT_INJECT_RESULT, (_e: unknown, result: { success: boolean; platformName?: string }) => {
      const promptWindow = getPromptWindow()
      if (promptWindow && !promptWindow.isDestroyed()) {
        promptWindow.webContents.send(IPC_CHANNELS.PROMPT_INJECT_RESULT, result)
      }
    })
  } else {
    ipcMain.on(IPC_CHANNELS.PROMPT_INJECT_RESULT, (_e, result: { success: boolean; platformName?: string }) => {
      const promptWindow = getPromptWindow()
      if (promptWindow && !promptWindow.isDestroyed()) {
        promptWindow.webContents.send(IPC_CHANNELS.PROMPT_INJECT_RESULT, result)
      }
    })
  }
}
