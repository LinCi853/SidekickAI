// electron/ai/handler.ts — AI Provider 测试 + Chat IPC handler 注册
//
// 整合 ai-provider-store（Provider 配置）、chat-store（SQLite 对话持久化）、
// ai/client（SSE 流式 API 调用）三个模块，注册到 ipcMain：
//   - AI_PROVIDER_TEST：测试 Provider 连通性
//   - CHAT_LIST_CONVERSATIONS / CREATE / DELETE
//   - CHAT_LIST_MESSAGES / SAVE_MESSAGE / SEARCH
//   - CHAT_SEND：发送消息 → 流式调用 API → 实时推 chunk → 入库
//   - CHAT_CANCEL：取消正在进行的流式请求
//   - CHAT_LOG_WINDOW_TRACE / LOGIN_TRACE / LIST_*
//
// 流式推送通过 senderWebContents.send 推到发起方窗口的渲染进程，
// 避免跨窗口串流。

import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron'
import { writeFile, readFile } from 'fs/promises'
import { aiProviderStore } from '../store/ai-provider-store.js'
import { getChatStore } from '../store/chat-store.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { injectionHistoryStore } from '../store/injection-history-store.js'
import { streamChat, testProvider, listModels } from './client.js'
import { showNotification } from '../notify.js'
import { IPC_CHANNELS } from '../shared/types.js'
import type {
  CustomAIProvider,
  CustomAIProviderInput,
  ChatSendPayload,
  ConversationSourceType,
  ChatMessage,
  WindowTraceAction,
  LoginTrace,
  ChatStreamChunk,
} from '../shared/types.js'

/** saveMessage 的参数类型（与 ChatAPI.saveMessage 一致） */
type SaveMessageInput = Omit<ChatMessage, 'id' | 'createdAt'> &
  Partial<Pick<ChatMessage, 'id' | 'createdAt'>>

/** 正在进行的流式请求：conversationId -> AbortController */
const activeStreams = new Map<string, AbortController>()

/**
 * 注册所有 AI Provider / Chat 相关 IPC handler
 *
 * 必须在 app.whenReady() 且 chatStore 初始化后调用。
 * AI Provider CRUD（list/create/update/delete）在 ai-provider-store.ts 中注册。
 */
export function registerAIChatIPC(): void {
  const ipc = IPC_CHANNELS

  // ===== AI Provider 测试连通性 =====
  ipcMain.handle(
    ipc.AI_PROVIDER_TEST,
    async (_e, input: CustomAIProviderInput) => {
      // 构造临时 Provider 对象（不需要 id/时间戳）
      const provider = {
        id: 'test',
        createdAt: 0,
        updatedAt: 0,
        ...input,
      }
      return testProvider(provider)
    },
  )

  // 需求 9：列出 Provider 可用模型（自动搜索）
  ipcMain.handle(
    ipc.AI_PROVIDER_LIST_MODELS,
    async (_e, input: CustomAIProviderInput) => {
      return listModels(input)
    },
  )

  // ===== 会话 CRUD =====
  ipcMain.handle(ipc.CHAT_LIST_CONVERSATIONS, (_e, sourceId?: string) => {
    return getChatStore().listConversations(sourceId)
  })

  ipcMain.handle(
    ipc.CHAT_CREATE_CONVERSATION,
    (_e, sourceId: string, sourceType: ConversationSourceType, title: string, url?: string) => {
      return getChatStore().createConversation(sourceId, sourceType, title, url)
    },
  )

  ipcMain.handle(ipc.CHAT_GET_LAST_CONV_URL, (_e, sourceId: string) => {
    return getChatStore().getLastConversationUrl(sourceId)
  })

  ipcMain.handle(ipc.CHAT_DELETE_CONVERSATION, (_e, id: string) => {
    getChatStore().deleteConversation(id)
  })

  // ===== 消息 CRUD =====
  ipcMain.handle(ipc.CHAT_LIST_MESSAGES, (_e, conversationId: string) => {
    return getChatStore().listMessages(conversationId)
  })

  ipcMain.handle(ipc.CHAT_SAVE_MESSAGE, (_e, msg: SaveMessageInput) => {
    return getChatStore().saveMessage(msg)
  })

  // 需求 5：智能合并保存（Jaccard 相似度 ≥ 0.85 时更新而非新增）
  ipcMain.handle(ipc.CHAT_SAVE_MESSAGE_WITH_MERGE, (_e, msg: SaveMessageInput) => {
    return getChatStore().saveMessageWithMerge(msg)
  })

  // webview 抓取入库后，渲染层通知主进程广播给所有窗口
  // HistoryView 订阅 CHAT_CONVERSATION_PERSISTED 以实时刷新侧边栏
  ipcMain.handle(ipc.CHAT_NOTIFY_PERSISTED, (_e, sourceId: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      // 避免回发给发起方窗口（WebviewTab 自己不需要刷新）
      if (w.webContents === _e.sender) continue
      w.webContents.send(ipc.CHAT_CONVERSATION_PERSISTED, { sourceId })
    }
  })

  ipcMain.handle(ipc.CHAT_SEARCH, (_e, query: string) => {
    return getChatStore().search(query)
  })

  // ===== 发送消息（核心：流式 API + SQLite 入库）=====
  ipcMain.handle(
    ipc.CHAT_SEND,
    async (e, payload: ChatSendPayload) => {
      const sender = e.sender
      const chatStore = getChatStore()
      const provider = aiProviderStore.get(payload.providerId)
      if (!provider) {
        throw new Error(`Provider 不存在: ${payload.providerId}`)
      }

      // 1. 创建或复用会话
      let conversationId = payload.conversationId
      if (!conversationId) {
        const title = payload.title || payload.message.slice(0, 30) || '新对话'
        const conv = chatStore.createConversation(provider.id, 'api', title)
        conversationId = conv.id
      }

      // 2. 保存用户消息
      const userMsg = chatStore.saveMessage({
        conversationId,
        role: 'user',
        content: payload.message,
      })

      // 3. 取消该会话之前未完成的流式请求（如果有）
      const prev = activeStreams.get(conversationId)
      if (prev) prev.abort()

      // 4. 创建 AbortController 并登记
      const controller = new AbortController()
      activeStreams.set(conversationId, controller)

      // 5. 加载历史消息（含刚保存的 user 消息）作为 API 上下文
      const history = chatStore.listMessages(conversationId)

      // 若指定了 systemPrompt，在历史消息前注入 system 消息（不入库，仅用于 API 请求）
      const messages: ChatMessage[] = payload.systemPrompt?.trim()
        ? [
            {
              id: 'system',
              conversationId,
              role: 'system' as const,
              content: payload.systemPrompt,
              createdAt: Date.now(),
            },
            ...history,
          ]
        : history

      // 6. 异步发起流式调用（不 await，立即返回 conversationId）
      void runStream(
        sender,
        conversationId,
        provider,
        messages,
        controller,
        userMsg.id,
        {
          recordTextPrefix: payload.recordTextPrefix,
          recordTextSuffix: payload.recordTextSuffix,
          tag: payload.tag,
        },
      )

      return { conversationId, userMessageId: userMsg.id }
    },
  )

  // ===== 取消流式请求 =====
  ipcMain.handle(ipc.CHAT_CANCEL, (_e, conversationId: string) => {
    const controller = activeStreams.get(conversationId)
    if (controller) {
      controller.abort()
      activeStreams.delete(conversationId)
    }
  })

  // ===== token 用量统计 =====
  ipcMain.handle(ipc.CHAT_GET_USAGE_STATS, (_e, sourceId?: string) => {
    return getChatStore().getUsageStats(sourceId)
  })

  // ===== 对话导出（MD/JSON）=====
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

  // ===== 对话导入 =====
  ipcMain.handle(
    ipc.CHAT_IMPORT_CONVERSATION,
    async (e, format: 'json' | 'deepseek' | 'md', sourceId: string) => {
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
    },
  )

  // ===== 清空所有对话 =====
  ipcMain.handle(
    ipc.CHAT_CLEAR_CONVERSATIONS,
    (_e, sourceId?: string) => {
      const count = getChatStore().clearAllConversations(sourceId)
      return { ok: true, count }
    },
  )

  // ===== 清空登录痕迹 =====
  ipcMain.handle(
    ipc.CHAT_CLEAR_LOGIN_TRACES,
    (_e, profileId?: string) => {
      const count = getChatStore().clearLoginTraces(profileId)
      return { ok: true, count }
    },
  )

  // ===== 清空窗口操作痕迹 =====
  ipcMain.handle(
    ipc.CHAT_CLEAR_WINDOW_TRACES,
    (_e, windowId?: string) => {
      const count = getChatStore().clearWindowTraces(windowId)
      return { ok: true, count }
    },
  )

  // ===== 更新消息 =====
  ipcMain.handle(
    ipc.CHAT_UPDATE_MESSAGE,
    (_e, messageId: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>) => {
      getChatStore().updateMessage(messageId, updates)
      return { ok: true }
    },
  )

  // ===== 删除单条消息 =====
  ipcMain.handle(
    ipc.CHAT_DELETE_MESSAGE,
    (_e, messageId: string) => {
      getChatStore().deleteMessage(messageId)
      return { ok: true }
    },
  )

  // ===== 更新会话标题 =====
  ipcMain.handle(
    ipc.CHAT_UPDATE_CONVERSATION,
    (_e, id: string, updates: { title?: string }) => {
      getChatStore().touchConversation(id, updates.title)
      return { ok: true }
    },
  )

  // ===== 痕迹记录 =====
  ipcMain.handle(
    ipc.CHAT_LOG_WINDOW_TRACE,
    (_e, windowId: string, action: WindowTraceAction, detail?: unknown) => {
      getChatStore().logWindowTrace(windowId, action, detail)
    },
  )

  ipcMain.handle(
    ipc.CHAT_LOG_LOGIN_TRACE,
    (_e, trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>) => {
      getChatStore().logLoginTrace(trace)
    },
  )

  ipcMain.handle(ipc.CHAT_LIST_WINDOW_TRACES, (_e, windowId?: string, limit?: number) => {
    return getChatStore().listWindowTraces(windowId, limit)
  })

  ipcMain.handle(ipc.CHAT_LIST_LOGIN_TRACES, (_e, profileId?: string) => {
    return getChatStore().listLoginTraces(profileId)
  })

  // ===== 使用统计与操作日志 =====
  // 点击日志：受 usageTrackingEnabled 守卫，关闭时静默丢弃
  ipcMain.handle(ipc.USAGE_TRACE_LOG_CLICK, (_e, elementName: string, windowType: string | null, detail?: unknown) => {
    try {
      if (!getAppSettings().usageTrackingEnabled) return { ok: false, skipped: true }
      getChatStore().logClick(elementName, windowType, detail)
      return { ok: true }
    } catch (err) {
      console.warn('[ai-handler] logClick 失败:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(ipc.USAGE_TRACE_GET_STATS, (_e, rangeDays?: number) => {
    try {
      return { ok: true, stats: getChatStore().getFrequencyStats(rangeDays) }
    } catch (err) {
      console.warn('[ai-handler] getFrequencyStats 失败:', err)
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle(ipc.USAGE_TRACE_CLEAR, () => {
    try {
      const count = getChatStore().clearUsageTraces()
      return { ok: true, count }
    } catch (err) {
      console.warn('[ai-handler] clearUsageTraces 失败:', err)
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
      console.log(`[ai-handler] 启动清理：删除 ${result.deletedCount} 条无效会话`)
    }
  } catch (e) {
    console.error('[ai-handler] 清理无效会话失败:', e)
  }

  // ===== 需求 2：注入历史（预览 + Jaccard 去重） =====
  ipcMain.handle(ipc.INJECTION_LOG, (_e, record) => {
    return injectionHistoryStore.log(record)
  })
  ipcMain.handle(ipc.INJECTION_LIST_RECENT, (_e, limit?: number) => {
    return injectionHistoryStore.listRecent(limit)
  })
  ipcMain.handle(ipc.INJECTION_FIND_SIMILAR, (_e, text: string, limit?: number, threshold?: number) => {
    return injectionHistoryStore.findSimilar(text, limit, threshold)
  })
  ipcMain.handle(ipc.INJECTION_CLEAR, () => {
    return injectionHistoryStore.clear()
  })
}

/**
 * 执行流式 API 调用：实时推送 chunk，结束后保存 assistant 消息
 *
 * 不向调用方抛错，所有错误通过 stream-end 事件推送到渲染层。
 *
 * 需求 10：recordTemplate 包含 recordTextPrefix/Suffix/tag，在保存 assistant 消息前应用模板。
 * 占位符：{{time}} → YYYY-MM-DD HH:mm:ss；{{tag}} → recordTemplate.tag
 */
async function runStream(
  sender: WebContents,
  conversationId: string,
  provider: CustomAIProvider,
  history: ChatMessage[],
  controller: AbortController,
  userMessageId: string,
  recordTemplate?: { recordTextPrefix?: string; recordTextSuffix?: string; tag?: string },
): Promise<void> {

  let fullText = ''
  // token 用量（由 onUsage 回填，onDone 时写入消息）
  let promptTokens = 0
  let completionTokens = 0

  const sendChunk = (delta: string) => {
    fullText += delta
    const chunk: ChatStreamChunk = { conversationId, delta, done: false }
    if (!sender.isDestroyed()) {
      sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunk)
    }
  }

  const sendEnd = (ok: boolean, error?: string, assistantMessageId?: string) => {
    activeStreams.delete(conversationId)
    if (!sender.isDestroyed()) {
      sender.send(IPC_CHANNELS.CHAT_STREAM_END, { conversationId, ok, error, assistantMessageId })
    }
  }

  // 需求 10：应用记录文本模板（前缀/后缀 + 占位符 {{time}} {{tag}}）
  const applyRecordTemplate = (text: string): string => {
    if (!recordTemplate) return text
    const prefix = recordTemplate.recordTextPrefix?.trim()
    const suffix = recordTemplate.recordTextSuffix?.trim()
    if (!prefix && !suffix) return text
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const tag = recordTemplate.tag ?? ''
    const fill = (s: string) =>
      s.replace(/\{\{time\}\}/g, timeStr).replace(/\{\{tag\}\}/g, tag)
    return `${fill(prefix ?? '')}${text}${fill(suffix ?? '')}`
  }

  try {
    await streamChat(
      provider,
      history,
      {
        onDelta: sendChunk,
        onUsage: (usage) => {
          promptTokens = usage.promptTokens
          completionTokens = usage.completionTokens
          // 回填用户消息的输入 token 数
          try {
            if (promptTokens > 0) {
              getChatStore().updateMessageTokens(userMessageId, promptTokens)
            }
          } catch (e) {
            console.error('[ai-handler] 回填 user tokens 失败:', e)
          }
        },
        onDone: (text) => {
          // 保存 assistant 消息到 SQLite（含 completionTokens），并取回真实 id 随 stream-end 下发
          // 需求 10：保存前应用记录文本模板（前缀/后缀）
          const finalText = applyRecordTemplate(text)
          let assistantMsg: ChatMessage | undefined
          try {
            if (finalText.trim()) {
              assistantMsg = getChatStore().saveMessage({
                conversationId,
                role: 'assistant',
                content: finalText,
                tokens: completionTokens || undefined,
              })
            }
          } catch (e) {
            console.error('[ai-handler] 保存 assistant 消息失败:', e)
          }
          // 6.4: AbortError 被客户端视为 onDone，但实际是用户取消。
          //      检测 signal.aborted 改走 sendEnd(false) 路径，让渲染层知道是取消而非正常完成。
          if (controller.signal.aborted) {
            sendEnd(false, 'aborted', assistantMsg?.id)
            return
          }
          sendEnd(true, undefined, assistantMsg?.id)
          // 仅当发起方窗口未聚焦时才弹通知，避免高频对话打扰用户
          const win = BrowserWindow.fromWebContents(sender)
          if (!win || !win.isFocused()) {
            showNotification('AI 回复完成', `${provider.name} 已完成本轮响应`)
          }
        },
        onError: (err) => {
          console.error('[ai-handler] 流式请求失败:', err)
          // 失败时仍保存已收到的部分文本（便于调试）
          if (fullText.trim()) {
            try {
              getChatStore().saveMessage({
                conversationId,
                role: 'assistant',
                content: applyRecordTemplate(fullText + `\n\n[错误中断: ${err.message}]`),
              })
            } catch (e) {
              console.error('[ai-handler] 保存部分文本失败:', e)
            }
          }
          sendEnd(false, err.message)
        },
      },
      { signal: controller.signal },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ai-handler] runStream 异常:', msg)
    sendEnd(false, msg)
  }
}

/** 清理所有进行中的流式请求（app before-quit 时调用） */
export function cleanupActiveStreams(): void {
  for (const [, controller] of activeStreams) {
    try {
      controller.abort()
    } catch (e: unknown) {
      console.warn('[ai-handler] 中止流式请求失败:', e)
    }
  }
  activeStreams.clear()
}
