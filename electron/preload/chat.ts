import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type AIPlatform, type ChatStreamChunk } from '../shared/types.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'

export const chatApi = {
  // 对话持久化（SQLite）
  chat: {
    listConversations: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_CONVERSATIONS, sourceId),
    createConversation: (sourceId: string, sourceType: string, title: string, url: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
        sourceId,
        sourceType,
        title,
        url,
      ),
    getLastConversationUrl: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_LAST_CONV_URL, sourceId),
    deleteConversation: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, id),
    listMessages: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_MESSAGES, conversationId),
    saveMessageWithMerge: (msg: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_SAVE_MESSAGE_WITH_MERGE, msg),
    // webview 抓取入库后通知主进程广播给其他窗口（HistoryView 订阅刷新侧边栏）
    notifyConversationPersisted: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_NOTIFY_PERSISTED, sourceId),
    // 订阅入库广播事件（主进程 → 所有窗口）
    onConversationPersisted: (callback: (payload: { sourceId: string }) => void) => {
      const handler = (_e: unknown, payload: { sourceId: string }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_CONVERSATION_PERSISTED, handler)
    },
    search: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEARCH, query),
    send: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload),
    cancel: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CANCEL, conversationId),
    onStreamChunk: (callback: (chunk: ChatStreamChunk) => void) => {
      const handler = (
        _e: unknown,
        chunk: ChatStreamChunk,
      ) => callback(chunk)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, handler)
    },
    onStreamEnd: (callback: (info: { conversationId: string; ok: boolean; error?: string }) => void) => {
      const handler = (
        _e: unknown,
        info: { conversationId: string; ok: boolean; error?: string },
      ) => callback(info)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_END, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_END, handler)
    },
    logLoginTrace: (trace: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOG_LOGIN_TRACE, trace),
    listWindowTraces: (windowId: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_WINDOW_TRACES, windowId, limit),
    listLoginTraces: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_LOGIN_TRACES, profileId),
    getUsageStats: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_USAGE_STATS, sourceId),
    exportConversation: (conversationId: string, format: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_EXPORT_CONVERSATION, conversationId, format),
    importConversation: (format: string, sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_IMPORT_CONVERSATION, format, sourceId),
    clearConversations: (sourceId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_CONVERSATIONS, sourceId),
    clearLoginTraces: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_LOGIN_TRACES, profileId),
    clearWindowTraces: (windowId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLEAR_WINDOW_TRACES, windowId),
    // 使用统计与操作日志
    clearUsageTraces: () =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_TRACE_CLEAR),
    updateMessage: (messageId: string, updates: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MESSAGE, messageId, updates),
    deleteMessage: (messageId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_MESSAGE, messageId),
    updateConversation: (id: string, updates: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_CONVERSATION, id, updates),
    openHistoryWindow: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_OPEN_HISTORY_WINDOW),
    updateDetachedWindow: (windowId: string, config: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_DETACHED, windowId, config),
    getChatConfig: (windowId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_CONFIG, windowId),
    // Alt+Q 无对话窗口时，主进程请求打开配置
    onRequestConfig: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_CONFIG, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_CONFIG, handler)
    },
  },
  // 自定义 AI 提供商
  aiProvider: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_LIST),
    create: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_CREATE, input),
    update: (id: string, patch: unknown) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_UPDATE, id, patch),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_DELETE, id),
    test: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_TEST, input),
    listModels: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_LIST_MODELS, input),
    exportEncrypted: (password: string, selectedIds?: string[]) => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_EXPORT_ENCRYPTED, password, selectedIds),
    importEncrypted: (encrypted: string, password: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_IMPORT_ENCRYPTED, encrypted, password),
    // v0.5.2 B-4：预览导入（dry-run）
    previewImport: (encrypted: string, password: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_PREVIEW_IMPORT, encrypted, password),
    // v0.5.2 B-4：选择导出文件保存路径（.sapp 文件）
    selectExportPath: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_SELECT_EXPORT_PATH),
    // v0.5.2 B-4：选择导入文件
    selectImportFile: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_SELECT_IMPORT_FILE),
    // v0.5.2 B-4：写入加密导出文件
    writeExportFile: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_WRITE_EXPORT_FILE, filePath, content),
    // v0.5.2 B-4：读取导入文件
    readImportFile: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_PROVIDER_READ_IMPORT_FILE, filePath),
  },
  // AI 平台
  aiPlatform: {
    // 同步获取预置平台列表（无 Profile 合并），用于立即渲染兜底
    presetList: (): AIPlatform[] => AI_PLATFORMS,
    // 异步获取完整列表（合并 Profile 自定义覆盖），静默更新
    list: () => ipcRenderer.invoke(IPC_CHANNELS.AI_PLATFORM_LIST),
  },
}
