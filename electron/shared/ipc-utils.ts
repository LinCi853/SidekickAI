// electron/shared/ipc-utils.ts — IPC 安全包装工具
//
// 提供 ipcMain.handle / ipcMain.on 的 try/catch 包装，统一错误日志与返回格式。
//
// 设计依据（现有 notes-db.ts / whiteboard-db.ts IPC handler 模式）：
//   - invoke 成功时直接返回数据（不包装为 {ok:true,data}），失败时返回 {ok:false,error}
//   - sendSync 的 returnValue：成功 {ok:true,data}（void 时 data=undefined，等价于现有 {ok:true}），
//     失败 {ok:false,error}
//
// requireSenderWindow 接收 findWindowId 函数作为参数注入，避免与 window-factory 产生
// 循环依赖（window-factory/helpers.ts 反向依赖 shared/ipc-channels.ts）。

import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

/** IPC 失败响应（成功时直接返回数据，不包装） */
export interface IpcErrorResponse {
  ok: false
  error: string
}

/**
 * 包装 ipcMain.handle：自动 try/catch + console.error + 标准化错误返回。
 *
 * - 成功：直接返回 handler 的返回值（与现有 notes-db/whiteboard-db 一致，不包装为 {ok:true,data}）
 * - 失败：console.error 记录日志，返回 {ok:false, error:String(err)}
 *
 * @param channel IPC 频道名
 * @param handler 业务处理函数，返回值直接透传给渲染进程
 * @param label   日志前缀标签（如 'notes-db'）
 */
export function registerSafeIpcHandler<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
  label: string,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (err) {
      console.error(`[${label}] 失败:`, err)
      return { ok: false, error: String(err) }
    }
  })
}

/**
 * 包装 ipcMain.on（同步 IPC，sendSync）：自动 try/catch + 设置 event.returnValue。
 *
 * - 成功：event.returnValue = {ok:true, data}（data 为 handler 返回值；void 时为 undefined，
 *         与现有 {ok:true} 行为等价）
 * - 失败：console.error 记录日志，event.returnValue = {ok:false, error:String(err)}
 *
 * @param channel IPC 频道名
 * @param handler 业务处理函数，返回值放入 returnValue.data
 * @param label   日志前缀标签
 */
export function registerSyncIpcHandler(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
  label: string,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      const data = handler(event, ...args)
      event.returnValue = { ok: true, data }
    } catch (err) {
      console.error(`[${label}] 失败:`, err)
      event.returnValue = { ok: false, error: String(err) }
    }
  })
}

/**
 * 从 IPC event 中提取发送方窗口与 windowId。
 *
 * @param event        IPC 事件（handle 或 on 均可，二者 sender 兼容）
 * @param findWindowId 通过 BrowserWindow 反查 windowId 的函数（通常传入
 *                     window-factory/helpers.ts 的 findWindowIdByWin，以参数注入
 *                     避免循环依赖）
 * @returns {win, windowId} 或 null（窗口已销毁 / windowId 未找到时）
 */
export function requireSenderWindow(
  event: IpcMainInvokeEvent,
  findWindowId: (win: BrowserWindow) => string | null,
): { win: BrowserWindow; windowId: string } | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  const windowId = findWindowId(win)
  if (!windowId) return null
  return { win, windowId }
}
