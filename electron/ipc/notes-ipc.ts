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

import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { windowState } from '../window-state.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { promptStore } from '../store/prompt-store.js'

/** 注册笔记额外 IPC handler（注入到 AI / 存为提示词） */
export function registerNotesExtraIpc(): void {
  // 需求 11：笔记 → 当前 AI 输入框
  // v0.5.2：笔记嵌入 StandaloneView，sender 即 进阶面板。
  // 查找最近聚焦窗口（lastFocusedWin），把笔记文本直接注入其激活的 AI 输入框。
  // 复用与语音注入相同的 VOICE_INJECT_AND_SEND 通道：渲染层 MainView/ChatView/AdvancedPanelView
  // 均已实现该监听器，自动适配 webview 输入框 / textarea / 自定义对话输入框。
  // 注入结果通过 NOTES_INJECT_RESULT 回传到调用方窗口（sender），供其显示 toast。
  ipcMain.handle(
    IPC_CHANNELS.NOTES_SEND_TO_AI,
    async (e, payload: { text: string; enterToSend?: boolean }) => {
      const text = payload?.text ?? ''
      if (!text.trim()) {
        return { ok: false, error: '笔记内容为空' }
      }
      // 选择目标窗口：优先 lastFocusedWin（排除 sender 自己），回退到 mainWindow
      const senderWin = BrowserWindow.fromWebContents(e.sender)
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
  // 将笔记内容作为新的 PromptTemplate 保存到提示词库。
  // 标题取笔记正文首行（截断 30 字符），分类默认 '笔记'。
  ipcMain.handle(
    IPC_CHANNELS.NOTES_SAVE_AS_PROMPT,
    async (_e, payload: { content: string; title?: string }) => {
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
