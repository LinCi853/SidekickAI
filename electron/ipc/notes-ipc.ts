// electron/ipc/notes-ipc.ts — 笔记相关额外 IPC 注册（注入到 AI / 存为提示词）
//
// 从 main.ts 抽离的 inline IPC handler：
//   - NOTES_SEND_TO_AI：把笔记文本注入到最近聚焦窗口的 AI 输入框（复用 VOICE_INJECT_AND_SEND）
//   - NOTES_SAVE_AS_PROMPT：把笔记内容作为新提示词模板保存到提示词库
//
// 注意：registerNotesIPC（笔记 SQLite CRUD + FTS5）仍由 store/notes-db.ts 注册，
// 本文件仅负责上述两个 main.ts 内联的额外 handler。
//
// 在 app.whenReady 后由 main.ts 调用 registerNotesExtraIpc() 完成注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { windowState } from '../window-state.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { promptStore } from '../store/prompt-store.js'
import type { EffectScope } from '../modules/effect-scope.js'

/**
 * 注册笔记额外 IPC handler（注入到 AI / 存为提示词）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerNotesExtraIpc(scope?: EffectScope): void {
  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // 需求 11：笔记 → 当前 AI 输入框
  handle(
    IPC_CHANNELS.NOTES_SEND_TO_AI,
    async (e: unknown, payload: { text: string; enterToSend?: boolean }) => {
      const text = payload?.text ?? ''
      if (!text.trim()) {
        return { ok: false, error: '笔记内容为空' }
      }
      // 选择目标窗口：优先 lastFocusedWin（排除 sender 自己），回退到 mainWindow
      const senderWin = BrowserWindow.fromWebContents(e as any)
      let target = windowState.lastFocusedWin
      if (!target || target.isDestroyed() || !target.isVisible() || target === senderWin) {
        target = windowState.mainWindow
      }
      if (!target || target.isDestroyed() || target === senderWin) {
        return { ok: false, error: '未找到可注入的目标窗口' }
      }
      try {
        const enterToSend = payload.enterToSend ?? getAppSettings().enterToSend
        target.webContents.send(IPC_CHANNELS.VOICE_INJECT_AND_SEND, {
          text,
          enterToSend,
        })
        // 通知调用方窗口注入成功
        if (senderWin && !senderWin.isDestroyed()) {
          senderWin.webContents.send(IPC_CHANNELS.NOTES_INJECT_RESULT, {
            success: true,
          })
        }
        return { ok: true }
      } catch (err) {
        if (senderWin && !senderWin.isDestroyed()) {
          senderWin.webContents.send(IPC_CHANNELS.NOTES_INJECT_RESULT, {
            success: false,
            error: String(err),
          })
        }
        return { ok: false, error: String(err) }
      }
    },
  )

  // 需求 11：笔记 → 存为提示词
  handle(
    IPC_CHANNELS.NOTES_SAVE_AS_PROMPT,
    async (_e: unknown, payload: { content: string; title?: string }) => {
      const content = payload?.content ?? ''
      if (!content.trim()) {
        return { ok: false, error: '笔记内容为空' }
      }
      try {
        const title =
          payload.title?.trim() ||
          content.split('\n').map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 30) ||
          '未命名笔记'
        promptStore.save({
          id: '',
          title,
          content,
          category: '笔记',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        return { ok: true, title }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )
}
