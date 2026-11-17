// electron/browser/save-dialog.ts — 应用自建保存弹窗（主进程侧）
//
// 另存为不再调用系统原生“另存为”对话框，改为由应用自己的弹窗承接：
//   1. 主进程向发起窗口发送 SAVE_DIALOG_REQUEST
//   2. 渲染层弹出应用内弹窗，用户可勾选“以后保存到此位置（不再询问）”
//   3. 渲染层回 SAVE_DIALOG_RESULT，主进程拼装目标路径并完成保存
//
// 兜底：目标窗口未挂载自建弹窗（或已销毁）时回落到系统原生对话框，
// 保证一次保存只会出现一个对话框。

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import path from 'node:path'
import { IPC_CHANNELS } from '../shared/types.js'
import type {
  SaveDialogFilter,
  SaveDialogOutcome,
  SaveDialogReply,
  SaveDialogRequest,
} from '../shared/save-dialog.types.js'
import { safeDownloadFilename } from '../platform/security/download-path.js'

interface PendingRequest {
  resolve: (outcome: SaveDialogOutcome) => void
  timer: NodeJS.Timeout
  /** 只有发起该请求的窗口可以回执 */
  webContentsId: number
}

/** 等待用户确认的最长时间（超时按取消处理，避免同时出现两个对话框） */
const REQUEST_TIMEOUT_MS = 120_000

const pendingRequests = new Map<string, PendingRequest>()

/** 已挂载自建保存弹窗的渲染进程 */
const dialogHosts = new Set<number>()

export interface SaveDialogOptions {
  /** 弹窗标题 */
  title: string
  /** 建议文件名（不含目录） */
  fileName: string
  /** 默认目录 */
  directory: string
  /** 文件类型过滤 */
  filters?: SaveDialogFilter[]
}

/** 注册自建保存弹窗相关 IPC（主进程启动时调用一次） */
export function registerSaveDialogIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SAVE_DIALOG_HOST_READY, (event) => {
    const id = event.sender.id
    dialogHosts.add(id)
    // 窗口关闭后移除登记，避免旧 id 被后续窗口复用
    event.sender.once('destroyed', () => dialogHosts.delete(id))
    return { ok: true }
  })
  ipcMain.handle(
    IPC_CHANNELS.SAVE_DIALOG_RESULT,
    (event, requestId: string, reply: SaveDialogReply) => {
      const entry = pendingRequests.get(requestId)
      if (!entry) return { ok: false, error: 'unknown request' }
      // 只有发起请求的窗口可以回执
      if (entry.webContentsId !== event.sender.id) return { ok: false, error: 'wrong window' }
      pendingRequests.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(toOutcome(reply))
      return { ok: true }
    },
  )
}

/**
 * 在指定窗口弹出应用自建保存弹窗。
 * @param win 发起窗口；为空或未挂载自建弹窗时回落到系统原生对话框
 */
export async function showSaveDialog(
  win: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<SaveDialogOutcome> {
  const canUseInApp = !!win && !win.isDestroyed() && dialogHosts.has(win.webContents.id)
  if (!canUseInApp) return nativeSaveDialog(win, options)

  const requestId = randomUUID()
  const request: SaveDialogRequest = {
    requestId,
    title: options.title,
    fileName: options.fileName,
    directory: options.directory,
    filters: options.filters ?? [],
  }

  return new Promise<SaveDialogOutcome>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve({ action: 'cancel', remember: false })
    }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
    pendingRequests.set(requestId, {
      resolve,
      timer,
      webContentsId: win!.webContents.id,
    })
    try {
      win!.webContents.send(IPC_CHANNELS.SAVE_DIALOG_REQUEST, request)
    } catch (err) {
      console.error('[save-dialog] 发送保存请求失败:', err)
      pendingRequests.delete(requestId)
      clearTimeout(timer)
      void nativeSaveDialog(win, options).then(resolve)
    }
  })
}

/** 把渲染层回执转换为最终结果，并在勾选“记住默认”时写回生效的那一层设置 */
function toOutcome(reply: SaveDialogReply): SaveDialogOutcome {
  if (!reply || reply.action !== 'save') return { action: 'cancel', remember: false }
  const directory = (reply.directory ?? '').trim()
  const fileName = safeDownloadFilename((reply.fileName ?? '').trim() || 'download')
  if (!directory) return { action: 'cancel', remember: false }
  const filePath = path.join(directory, fileName)
  const remember = reply.remember === true
  return { action: 'save', filePath, remember }
}

/** 兜底：系统原生“另存为”对话框（窗口不支持自建弹窗时） */
async function nativeSaveDialog(
  win: BrowserWindow | null,
  options: SaveDialogOptions,
): Promise<SaveDialogOutcome> {
  const filters = options.filters?.length ? options.filters : undefined
  const result = win
    ? await dialog.showSaveDialog(win, {
        title: options.title,
        defaultPath: path.join(options.directory, safeDownloadFilename(options.fileName)),
        ...(filters ? { filters } : {}),
      })
    : await dialog.showSaveDialog({
        title: options.title,
        defaultPath: path.join(options.directory, safeDownloadFilename(options.fileName)),
        ...(filters ? { filters } : {}),
      })
  if (result.canceled || !result.filePath) return { action: 'cancel', remember: false }
  return { action: 'save', filePath: result.filePath, remember: false }
}
