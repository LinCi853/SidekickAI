// electron/modules/plugins/custom-chat/chat-ipc.ts — 自定义对话流式发送 IPC
//
// 会话/消息的读路径与 CRUD 在基础层 electron/store/chat-ipc.ts；本文件只负责
// 插件专属的流式发送与取消：
//   - AI_PROVIDER_TEST：测试 Provider 连通性
//   - AI_PROVIDER_LIST_MODELS：列出 Provider 可用模型
//   - CHAT_SEND：发送消息 → 流式调用 API → 实时推 chunk → 入库
//   - CHAT_CANCEL：取消正在进行的流式请求
//   - CHAT_UPDATE_MESSAGE / CHAT_DELETE_MESSAGE
//
// 活跃流通过基础端口 assets/asset-stream-activity.ts 登记，供资产清理判断与退出中止。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain, BrowserWindow, type WebContents } from 'electron'
import type { EffectScope } from '../../effect-scope.js'
import { randomUUID } from 'node:crypto'
import { StreamAssetRecorder } from '../../../assets/stream-recorder.js'
import { trackAssetStream } from '../../../assets/asset-stream-activity.js'
import { aiProviderStore } from '../../../store/ai-provider-store.js'
import { getChatStore } from '../../../store/chat-store.js'
import { streamChat, testProvider, listModels } from '../../../ai/client.js'
import { showNotification } from '../../../notify.js'
import { IPC_CHANNELS } from '../../../shared/types.js'
import type {
  CustomAIProvider,
  CustomAIProviderInput,
  ChatSendPayload,
  ChatMessage,
  ChatStreamChunk,
} from '../../../shared/types.js'

/** 正在进行的流式请求：conversationId -> AbortController */
const activeStreams = new Map<string, AbortController>()

/**
 * 注册自定义对话模块的流式发送 IPC handler。
 *
 * 必须在 app.whenReady() 且 chatStore 初始化后调用。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerAIChatIPC(scope?: EffectScope): void {
  const ipc = IPC_CHANNELS

  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  // ===== AI Provider 测试连通性 =====
  handle(
    ipc.AI_PROVIDER_TEST,
    async (_e: unknown, input: CustomAIProviderInput) => {
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
  handle(
    ipc.AI_PROVIDER_LIST_MODELS,
    async (_e: unknown, input: CustomAIProviderInput) => {
      return listModels(input)
    },
  )

  // ===== 发送消息（核心：流式 API + SQLite 入库；会话 CRUD 在基础层）=====
  handle(
    ipc.CHAT_SEND,
    async (e: any, payload: ChatSendPayload) => {
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
      const userMessageId = chatStore.assets.capture(conversationId, {
        key: randomUUID(), role: 'user', content: payload.message, status: 'complete',
      })
      if (!userMessageId) throw new Error('对话已删除，无法继续发送')

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
      )

      return { conversationId, userMessageId: userMessageId }
    },
  )

  // ===== 取消流式请求 =====
  handle(ipc.CHAT_CANCEL, (_e: unknown, conversationId: string) => {
    const controller = activeStreams.get(conversationId)
    if (controller) {
      controller.abort()
      activeStreams.delete(conversationId)
    }
  })

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
}

/**
 * 执行流式 API 调用：实时推送 chunk，结束后保存 assistant 消息
 *
 * 不向调用方抛错，所有错误通过 stream-end 事件推送到渲染层。
 */
async function runStream(
  sender: WebContents,
  conversationId: string,
  provider: CustomAIProvider,
  history: ChatMessage[],
  controller: AbortController,
): Promise<void> {

  const release = trackAssetStream(controller)
  const assistantMessageId = randomUUID()
  let assistantMessageStored = false
  const recorder = new StreamAssetRecorder(value => {
    const captured = getChatStore().assets.capture(conversationId, {
      key: assistantMessageId, role: 'assistant', content: value.content,
      reasoning: value.reasoning, status: value.status,
    }, assistantMessageId)
    assistantMessageStored = !!captured
    if (!captured) return
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, { sourceId: provider.id })
    }
  })
  const sendChunk = (delta: string) => {
    recorder.append('output', delta)
    const chunk: ChatStreamChunk = { conversationId, delta, done: false }
    if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunk)
  }
  const sendEnd = (ok: boolean, error?: string) => {
    if (activeStreams.get(conversationId) === controller) activeStreams.delete(conversationId)
    if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.CHAT_STREAM_END, {
      conversationId, ok, error, assistantMessageId: assistantMessageStored ? assistantMessageId : undefined,
    })
  }
  try {
    await streamChat(provider, history, {
      onDelta: sendChunk,
      onReasoningDelta: delta => recorder.append('reasoning', delta),
      onDone: text => {
        const stopped = controller.signal.aborted
        recorder.finish(stopped ? 'stopped' : 'complete', text)
        sendEnd(!stopped, stopped ? 'aborted' : undefined)
        const window = BrowserWindow.fromWebContents(sender)
        if (!stopped && (!window || !window.isFocused())) showNotification('AI 回复完成', `${provider.name} 已完成本轮响应`)
      },
      onError: error => {
        recorder.finish('failed')
        sendEnd(false, error.message)
      },
    }, { signal: controller.signal })
  } catch (error) {
    try { recorder.finish(controller.signal.aborted ? 'stopped' : 'failed') } catch (saveError) {
      sendEnd(false, `本地记录保存失败：${String(saveError)}`)
      return
    }
    sendEnd(false, error instanceof Error ? error.message : String(error))
  } finally { release() }
}

/** 清理所有进行中的流式请求（模块停用 / app before-quit 时调用） */
export function cleanupActiveStreams(): void {
  for (const [, controller] of activeStreams) {
    try {
      controller.abort()
    } catch (e: unknown) {
      console.warn('[custom-chat] 中止流式请求失败:', e)
    }
  }
  activeStreams.clear()
}
