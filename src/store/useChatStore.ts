/* =====================================================================
   store/useChatStore.ts —— 自定义对话状态管理
   管理：Provider 列表、会话列表、当前会话消息、流式接收状态。
   所有数据通过 window.electron.aiProvider / chat API 与主进程交互，
   对话内容持久化到 SQLite。
   ===================================================================== */

import { create } from 'zustand';
import {
  listAIProviders,
  createAIProvider,
  updateAIProvider,
  deleteAIProvider,
  testAIProvider,
  listConversations,
  deleteConversation,
  listMessages,
  sendChat,
  cancelChat,
  onChatStreamChunk,
  onChatStreamEnd,
  updateMessage,
  type CustomAIProvider,
  type CustomAIProviderInput,
  type Conversation,
  type ChatMessage,
} from '../lib/electron-api';

interface ChatState {
  // Provider 管理
  providers: CustomAIProvider[];
  currentProviderId: string | null;
  loadingProviders: boolean;

  // 会话管理
  conversations: Conversation[];
  currentConversationId: string | null;
  messages: ChatMessage[];

  // 流式状态
  streaming: boolean;
  /** 流式过程中累积的 assistant 文本（实时显示） */
  streamingText: string;
  streamError: string | null;
  /** 当前正在流式的会话 id（与 currentConversationId 解耦，确保切换会话时流式状态可复位） */
  streamingConversationId: string | null;
  /** 6.4: 标记 streamingText 是否已被 cancelStream 固化为消息（防止 onChatStreamEnd 重复追加） */
  streamFinalized: boolean;

  // 初始化
  initProviders: () => Promise<void>;
  initConversations: () => Promise<void>;

  // Provider CRUD
  addProvider: (input: CustomAIProviderInput) => Promise<CustomAIProvider>;
  editProvider: (id: string, patch: Partial<CustomAIProviderInput>) => Promise<CustomAIProvider>;
  removeProvider: (id: string) => Promise<void>;
  testProviderConn: (input: CustomAIProviderInput) => Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  setCurrentProvider: (id: string) => void;

  // 会话操作
  selectConversation: (id: string | null) => Promise<void>;
  startNewConversation: () => void;
  removeConversation: (id: string) => Promise<void>;

  // 发送消息
  // 需求 10：recordTextPrefix/Suffix/tag 由调用方传入（来自 chatConfig），主进程保存 assistant 消息前应用模板
  sendMessage: (
    text: string,
    systemPrompt?: string,
    recordTemplate?: { recordTextPrefix?: string; recordTextSuffix?: string; tag?: string },
  ) => Promise<void>;
  cancelStream: () => Promise<void>;

  // 6.5 消息编辑/重试/继续
  editMessage: (msgId: string, newContent: string) => Promise<void>;
  retryLastMessage: () => void;
  continueGeneration: () => void;

  // 流式监听注册（在组件 mount 时调用一次）
  registerStreamListeners: () => () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  providers: [],
  currentProviderId: null,
  loadingProviders: false,

  conversations: [],
  currentConversationId: null,
  messages: [],

  streaming: false,
  streamingText: '',
  streamError: null,
  streamingConversationId: null,
  streamFinalized: false,

  initProviders: async () => {
    set({ loadingProviders: true });
    try {
      const list = await listAIProviders();
      const currentId = get().currentProviderId;
      // 保留已选 provider（若仍存在），否则取第一个
      const next = currentId && list.some((p) => p.id === currentId)
        ? currentId
        : list[0]?.id ?? null;
      set({ providers: list, currentProviderId: next, loadingProviders: false });
    } catch (e) {
      console.error('[useChatStore] 加载 Provider 列表失败:', e);
      set({ loadingProviders: false });
    }
  },

  initConversations: async () => {
    const providerId = get().currentProviderId;
    if (!providerId) {
      set({ conversations: [], currentConversationId: null, messages: [] });
      return;
    }
    try {
      // 不按 providerId 过滤：自定义对话窗口所有 API 来源的会话共享一个列表，
      // 用户可在任意对话中切换 Provider（模型）继续对话
      const list = await listConversations();
      // 仅显示 API 直连会话（webview 抓取的会话不在此窗口展示）
      set({ conversations: list.filter((c) => c.sourceType === 'api') });
    } catch (e) {
      console.error('[useChatStore] 加载会话列表失败:', e);
    }
  },

  addProvider: async (input) => {
    const created = await createAIProvider(input);
    set((s) => ({ providers: [...s.providers, created] }));
    return created;
  },

  editProvider: async (id, patch) => {
    const updated = await updateAIProvider(id, patch);
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? updated : p)),
    }));
    return updated;
  },

  removeProvider: async (id) => {
    await deleteAIProvider(id);
    set((s) => {
      const remaining = s.providers.filter((p) => p.id !== id);
      const next = s.currentProviderId === id
        ? remaining[0]?.id ?? null
        : s.currentProviderId;
      return { providers: remaining, currentProviderId: next };
    });
  },

  testProviderConn: async (input) => {
    return testAIProvider(input);
  },

  setCurrentProvider: (id) => {
    // 仅切换当前 Provider（模型），不清空当前会话和消息
    // 用户可在同一对话中任意切换模型继续对话
    set({ currentProviderId: id });
  },

  selectConversation: async (id) => {
    if (!id) {
      set({ currentConversationId: null, messages: [] });
      return;
    }
    try {
      const msgs = await listMessages(id);
      set({ currentConversationId: id, messages: msgs });
      // 需求 10：会话 id 持久化由调用方（ChatView/ChatTab）通过 chatConfig 或 localStorage 处理，
      // store 层不再写入 localStorage，避免与 chatConfig.lastConversationId 不同步
    } catch (e) {
      console.error('[useChatStore] 加载消息失败:', e);
    }
  },

  startNewConversation: () => {
    set({ currentConversationId: null, messages: [], streamingText: '', streamError: null, streamingConversationId: null, streamFinalized: false });
  },

  removeConversation: async (id) => {
    await deleteConversation(id);
    set((s) => {
      const remaining = s.conversations.filter((c) => c.id !== id);
      const next = s.currentConversationId === id ? null : s.currentConversationId;
      return {
        conversations: remaining,
        currentConversationId: next,
        messages: next ? s.messages : [],
      };
    });
  },

  sendMessage: async (text, systemPrompt, recordTemplate) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const providerId = get().currentProviderId;
    if (!providerId) {
      set({ streamError: '请先选择 AI 提供商（在设置中配置）' });
      return;
    }
    if (get().streaming) return; // 防止并发

    // 乐观插入用户消息（让 UI 立即响应）
    const tempUserMsg: ChatMessage = {
      id: `temp-user-${Date.now()}`,
      conversationId: get().currentConversationId ?? '',
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    set((s) => ({
      messages: [...s.messages, tempUserMsg],
      streaming: true,
      streamingConversationId: null,
      streamingText: '',
      streamError: null,
      // 6.4: 新一轮流式开始时重置固化标记
      streamFinalized: false,
    }));

    try {
      const result = await sendChat({
        conversationId: get().currentConversationId ?? undefined,
        providerId,
        message: trimmed,
        systemPrompt: systemPrompt?.trim() || undefined,
        // 需求 10：传递记录文本模板，主进程保存 assistant 消息前应用
        recordTextPrefix: recordTemplate?.recordTextPrefix,
        recordTextSuffix: recordTemplate?.recordTextSuffix,
        tag: recordTemplate?.tag,
      });
      // 更新会话 id（首次发送时主进程会创建会话）
      if (!get().currentConversationId) {
        set({ currentConversationId: result.conversationId });
      }
      // 记录正在流式的会话 id（与 currentConversationId 解耦）
      set({ streamingConversationId: result.conversationId });
      // 替换 tempUserMsg 的 id 为真实 id
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === tempUserMsg.id
            ? { ...m, id: result.userMessageId ?? m.id, conversationId: result.conversationId }
            : m,
        ),
      }));
    } catch (e) {
      console.error('[useChatStore] 发送消息失败:', e);
      set({
        streaming: false,
        streamError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  cancelStream: async () => {
    const convId = get().currentConversationId;
    if (convId) {
      await cancelChat(convId);
    }
    // 6.4: 立即将 streamingText 固化为 assistant 消息（不等 onChatStreamEnd 回调），
    //      防止 AbortError 未正确触发 IPC 回调导致内容丢失。
    //      注意：不清理 streamingConversationId，让 onChatStreamEnd 失败路径能匹配到当前会话，
    //      从而走到 streamFinalized 检查分支。
    const partial = get().streamingText;
    if (partial.trim()) {
      const assistantMsg: ChatMessage = {
        id: `cancel-${Date.now()}`,
        conversationId: convId ?? '',
        role: 'assistant',
        content: partial,
        createdAt: Date.now(),
      };
      set((s) => ({
        messages: [...s.messages, assistantMsg],
        streaming: false,
        streamingText: '',
        // 标记已固化，onChatStreamEnd 收到回调时不重复追加
        streamFinalized: true,
      }));
    } else {
      set({
        streaming: false,
        streamingText: '',
        streamFinalized: true,
      });
    }
  },

  // 6.5 消息编辑/重试/继续
  editMessage: async (msgId, newContent) => {
    try {
      const result = await updateMessage(msgId, { content: newContent });
      if (result.ok) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === msgId ? { ...m, content: newContent } : m,
          ),
        }));
      }
    } catch (e) {
      console.error('[useChatStore] editMessage 失败:', e);
    }
  },
  retryLastMessage: () => {
    const state = get();
    if (!state.currentConversationId || state.streaming) return;
    // 找到最后一条 user 消息，重新发送
    const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    void state.sendMessage(lastUser.content);
  },
  continueGeneration: () => {
    const state = get();
    if (!state.currentConversationId || state.streaming) return;
    // 找到最后一条 assistant 消息，发送"继续"指令
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return;
    void state.sendMessage('继续');
  },

  registerStreamListeners: () => {
    const offChunk = onChatStreamChunk((chunk) => {
      // 仅处理正在流式的会话的 chunk（与 currentConversationId 解耦，避免异会话分片污染当前显示）
      if (chunk.conversationId !== get().streamingConversationId) return;
      set((s) => ({ streamingText: s.streamingText + chunk.delta }));
    });
    const offEnd = onChatStreamEnd((info) => {
      // 异会话的结束：仅复位流式状态，避免切换会话后 streaming 永不复位
      if (info.conversationId !== get().streamingConversationId) {
        set({ streaming: false, streamingText: '', streamingConversationId: null });
        return;
      }
      const state = get();
      if (info.ok) {
        // 将流式累积的文本固化为一条 assistant 消息
        const finalText = state.streamingText;
        // 真正的 assistant 消息 id 由主进程在 stream-end 中下发（等 types.ts 同步该字段，此处用类型断言读取）
        const assistantId = (info as { assistantMessageId?: string }).assistantMessageId;
        const assistantMsg: ChatMessage = {
          id: assistantId ?? `server-${Date.now()}`,
          conversationId: info.conversationId,
          role: 'assistant',
          content: finalText,
          createdAt: Date.now(),
        };
        set((s) => ({
          messages: [...s.messages, assistantMsg],
          streaming: false,
          streamingText: '',
          streamingConversationId: null,
          streamError: null,
        }));
        // 刷新会话列表（更新时间会变化，新会话会出现在列表）
        void get().initConversations();
      } else {
        // 6.4: cancelStream 已固化 streamingText 时不重复追加，仅重置标记
        if (state.streamFinalized) {
          set({ streamFinalized: false, streaming: false, streamingText: '', streamingConversationId: null });
          return;
        }
        // 失败：保留已收到的部分文本作为 assistant 消息
        const partial = state.streamingText;
        set((s) => ({
          streaming: false,
          streamingText: '',
          streamingConversationId: null,
          streamError: info.error ?? '未知错误',
          messages: partial.trim()
            ? [
                ...s.messages,
                {
                  id: `error-${Date.now()}`,
                  conversationId: info.conversationId,
                  role: 'assistant' as const,
                  content: partial + `\n\n[错误: ${info.error}]`,
                  createdAt: Date.now(),
                },
              ]
            : s.messages,
        }));
      }
    });
    return () => {
      offChunk();
      offEnd();
    };
  },
}));
