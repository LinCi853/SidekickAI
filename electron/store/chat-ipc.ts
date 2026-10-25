// electron/store/chat-ipc.ts — 基础对话/痕迹 IPC 注册（chat.db 底座）
//
// 与自定义对话模块解耦：自定义对话关闭后，历史搜索、登录/窗口痕迹、
// 最近对话 URL、用量统计与会话/消息写路径仍可用（依赖规则 3.3）。
//
// 注册通道：
//   - CHAT_LIST_CONVERSATIONS / GET_LAST_CONV_URL / LIST_MESSAGES / SEARCH
//   - CHAT_NOTIFY_PERSISTED / GET_USAGE_STATS / CLEAR_*_TRACES
//   - CHAT_LOG_WINDOW_TRACE / LOG_LOGIN_TRACE / LIST_WINDOW_TRACES / LIST_LOGIN_TRACES
//   - CHAT_CREATE_CONVERSATION / DELETE_CONVERSATION / SAVE_MESSAGE(_WITH_MERGE)
//   - CHAT_UPDATE_CONVERSATION / EXPORT_CONVERSATION / IMPORT_CONVERSATION
//   - CHAT_CLEAR_CONVERSATIONS
//   - USAGE_TRACE_LOG_CLICK / GET_STATS / CLEAR / LIST_APP_STARTS / LIST_CLICK_LOGS

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { writeFile, readFile } from 'fs/promises'
import { getChatStore } from './chat-store.js'
import { getAppSettings } from './app-settings-repository.js'
import { showNotification } from '../notify.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { registerAiAssetIpc } from '../assets/asset-ipc.js'
import { runAssetImport } from '../assets/import-activity.js'
import type {
  ChatMessage,
  ConversationSourceType,
  WindowTraceAction,
  LoginTrace,
} from '../shared/types.js'

/** saveMessage 的参数类型（与 ChatAPI.saveMessage 一致） */
type SaveMessageInput = Omit<ChatMessage, 'id' | 'createdAt'> &
  Partial<Pick<ChatMessage, 'id' | 'createdAt'>>

/**
 * 注册对话/痕迹基础 IPC（基础功能：历史搜索 FTS5、登录/窗口痕迹、最近对话 URL、用量统计）。
 * 与自定义对话模块解耦：自定义对话关闭后这些读路径与记录仍可用（依赖规则 3.3）。
 */
export function registerBaseChatIpc(): void {
  registerAiAssetIpc()
  const ipc = IPC_CHANNELS
  ipcMain.handle(ipc.CHAT_LIST_CONVERSATIONS, (_e, sourceId?: string) => {
    return getChatStore().listConversations(sourceId)
  })
  ipcMain.handle(ipc.CHAT_GET_LAST_CONV_URL, (_e, sourceId: string) => {
    return getChatStore().getLastConversationUrl(sourceId)
  })
  ipcMain.handle(ipc.CHAT_LIST_MESSAGES, (_e, conversationId: string) => {
    return getChatStore().listMessages(conversationId)
  })
  // webview 抓取入库后广播给所有窗口（HistoryView 实时刷新侧边栏）
  ipcMain.handle(ipc.CHAT_NOTIFY_PERSISTED, (_e, sourceId: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents === _e.sender) continue
      w.webContents.send(ipc.CHAT_CONVERSATION_PERSISTED, { sourceId })
    }
  })
  ipcMain.handle(ipc.CHAT_SEARCH, (_e, query: string) => {
    return getChatStore().search(query)
  })
  ipcMain.handle(ipc.CHAT_GET_USAGE_STATS, (_e, sourceId?: string) => {
    return getChatStore().getUsageStats(sourceId)
  })
  ipcMain.handle(ipc.CHAT_CLEAR_LOGIN_TRACES, (_e, profileId?: string) => {
    return { ok: true, count: getChatStore().clearLoginTraces(profileId) }
  })
  ipcMain.handle(ipc.CHAT_CLEAR_WINDOW_TRACES, (_e, windowId?: string) => {
    return { ok: true, count: getChatStore().clearWindowTraces(windowId) }
  })
  ipcMain.handle(
    ipc.CHAT_LOG_WINDOW_TRACE,
    (_e, windowId: string, action: WindowTraceAction, detail?: unknown) => {
      getChatStore().logWindowTrace(windowId, action, detail)
    },
  )
  ipcMain.handle(
    ipc.CHAT_LOG_LOGIN_TRACE,
    (
      _e,
      trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>,
    ) => {
      getChatStore().logLoginTrace(trace)
    },
  )
  ipcMain.handle(ipc.CHAT_LIST_WINDOW_TRACES, (_e, windowId?: string, limit?: number) => {
    return getChatStore().listWindowTraces(windowId, limit)
  })
  ipcMain.handle(ipc.CHAT_LIST_LOGIN_TRACES, (_e, profileId?: string) => {
    return getChatStore().listLoginTraces(profileId)
  })
  // ===== 会话/消息写路径（基础功能：WebviewTab 抓取入库、历史视图 CRUD 共用） =====
  ipcMain.handle(
    ipc.CHAT_CREATE_CONVERSATION,
    (_e, sourceId: string, sourceType: ConversationSourceType, title: string, url?: string) => {
      return getChatStore().createConversation(sourceId, sourceType, title, url)
    },
  )
  ipcMain.handle(ipc.CHAT_DELETE_CONVERSATION, (_e, id: string) => {
    getChatStore().deleteConversation(id)
  })
  ipcMain.handle(ipc.CHAT_SAVE_MESSAGE, (_e, msg: SaveMessageInput) => {
    return getChatStore().saveMessage(msg)
  })
  ipcMain.handle(ipc.CHAT_SAVE_MESSAGE_WITH_MERGE, (_e, msg: SaveMessageInput) => {
    return getChatStore().saveMessageWithMerge(msg)
  })
  ipcMain.handle(ipc.CHAT_UPDATE_CONVERSATION, (_e, id: string, updates: { title?: string }) => {
    getChatStore().touchConversation(id, updates.title)
    return { ok: true }
  })
  ipcMain.handle(
    ipc.CHAT_EXPORT_CONVERSATION,
    async (e, conversationId: string, format: 'md' | 'json') => {
      const content = getChatStore().exportConversation(conversationId, format)
      const win = BrowserWindow.fromWebContents(e.sender) || undefined
      const defaultName = `conversation-${conversationId.slice(0, 8)}.${format}`
      const ext = format === 'md' ? 'Markdown' : 'JSON'
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: `导出对话为 ${ext}`,
        defaultPath: defaultName,
        filters: [
          { name: ext, extensions: [format] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (canceled || !filePath) {
        return { ok: false, canceled: true }
      }
      await writeFile(filePath, content, 'utf-8')
      showNotification('导出成功', `已保存到 ${filePath}`)
      return { ok: true, filePath }
    },
  )
  ipcMain.handle(
    ipc.CHAT_IMPORT_CONVERSATION,
    (e, format: 'json' | 'deepseek' | 'md', sourceId: string) =>
      runAssetImport(async () => {
        const win = BrowserWindow.fromWebContents(e.sender) || undefined
        const filters = [
          { name: '所有支持的格式', extensions: ['json', 'md', 'markdown'] },
          { name: 'JSON', extensions: ['json'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: '所有文件', extensions: ['*'] },
        ]
        const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
          title: '导入对话',
          filters,
          properties: ['openFile'],
        })
        if (canceled || !filePaths || filePaths.length === 0) {
          return { ok: false, canceled: true }
        }
        const filePath = filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const conv = getChatStore().importConversation(format, content, sourceId)
        showNotification('导入成功', `已导入对话：${conv.title}`)
        return { ok: true, conversation: conv }
      }),
  )
  ipcMain.handle(ipc.CHAT_CLEAR_CONVERSATIONS, (_e, sourceId?: string) => {
    return { ok: true, count: getChatStore().clearAllConversations(sourceId) }
  })
}

/**
 * 注册使用统计与操作日志 IPC（基础功能：独立于自定义对话模块，
 * 自定义对话关闭后使用统计仍可用）。
 */
export function registerUsageTraceIpc(): void {
  const ipc = IPC_CHANNELS
  // 点击日志：受 usageTrackingEnabled 守卫，关闭时静默丢弃
  ipcMain.handle(
    ipc.USAGE_TRACE_LOG_CLICK,
    (_e, elementName: string, windowType: string | null, detail?: unknown) => {
      try {
        if (!getAppSettings().usageTrackingEnabled) return { ok: false, skipped: true }
        getChatStore().logClick(elementName, windowType, detail)
        return { ok: true }
      } catch (err) {
        console.warn('[chat-ipc] logClick 失败:', err)
        return { ok: false, error: String(err) }
      }
    },
  )
  ipcMain.handle(ipc.USAGE_TRACE_GET_STATS, (_e, rangeDays?: number) => {
    try {
      return { ok: true, stats: getChatStore().getFrequencyStats(rangeDays) }
    } catch (err) {
      console.warn('[chat-ipc] getFrequencyStats 失败:', err)
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle(ipc.USAGE_TRACE_CLEAR, () => {
    try {
      const count = getChatStore().clearUsageTraces()
      return { ok: true, count }
    } catch (err) {
      console.warn('[chat-ipc] clearUsageTraces 失败:', err)
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle(ipc.USAGE_TRACE_LIST_APP_STARTS, (_e, limit?: number) => {
    try {
      return { ok: true, list: getChatStore().listAppStarts(limit) }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle(ipc.USAGE_TRACE_LIST_CLICK_LOGS, (_e, limit?: number) => {
    try {
      return { ok: true, list: getChatStore().listClickLogs(limit) }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  // 7.1: 启动时清理无效会话（缺失 provider/source 的脏数据）
  try {
    const result = getChatStore().cleanupInvalidConversations()
    if (result.deletedCount > 0) {
      console.log(`[chat-ipc] 启动清理：删除 ${result.deletedCount} 条无效会话`)
    }
  } catch (e) {
    console.error('[chat-ipc] 清理无效会话失败:', e)
  }
}
