// 维护性说明：本文件超过 300 行建议上限。
// 拆分计划：抽离 ChatSidebar/ChatMessages/ChatInput/ChatTopBar 子组件。
// 暂缓原因：组件内会话管理、流式接收、语音注入状态紧密耦合，
// 拆分需仔细梳理 props 传递与状态依赖，避免破坏流式对话与用量统计功能。
/* =====================================================================
   pages/ChatView.tsx —— 自定义 AI 对话窗口（API 直连模式）
   架构：
   - 左侧：会话列表 + 新建按钮 + Provider 选择
   - 右侧：消息流（Markdown 渲染 + 代码高亮 + 头像 + 时间戳）+ 输入框
   - 顶栏：最小化/最大化/关闭/置顶 + Provider 切换
   - 流式接收：通过 useChatStore.registerStreamListeners 订阅
   - 数据持久化：所有对话通过主进程存入 SQLite
   - 窄屏适配：侧边栏折叠为抽屉
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { Button, IconButton, TitleBar } from '../components/ui';
import { useChatStore } from '../store/useChatStore';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  pinCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onPinToggled,
  onMaximizeToggled,
  getUsageStats,
  exportConversation,
  getChatConfig,
  onVoiceInjectAndSend,
  onWindowShown,
  openAiAppProviderWindow,
  updateChatDetachedWindow,
} from '../lib/electron-api';
import type { ChatWindowConfig, ChatWindowStyle } from '../lib/electron-api';
import { MessageBubble } from './MessageBubble';
import './ChatView.css';

export default function ChatView({ windowId }: { windowId?: string }) {
  const [input, setInput] = useState('');
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [usageStats, setUsageStats] = useState<{ totalTokens: number; todayTokens: number; todayCount: number } | null>(null);
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 600 : false,
  );
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [chatConfig, setChatConfig] = useState<ChatWindowConfig | null>(null);
  // 需求 10：记录文本模板折叠面板状态
  const [showRecordTemplate, setShowRecordTemplate] = useState(false);
  const [recordTextPrefix, setRecordTextPrefix] = useState('');
  const [recordTextSuffix, setRecordTextSuffix] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const {
    providers,
    currentProviderId,
    conversations,
    currentConversationId,
    messages,
    streaming,
    streamingText,
    streamError,
    initProviders,
    initConversations,
    setCurrentProvider,
    selectConversation,
    startNewConversation,
    removeConversation,
    sendMessage,
    cancelStream,
    editMessage,
    retryLastMessage,
    continueGeneration,
    registerStreamListeners,
  } = useChatStore();

  // 获取当前窗口的 chatConfig（chat 脱离窗口专属配置）
  // 需求 10：同时初始化记录文本模板状态（前缀/后缀）
  useEffect(() => {
    if (!windowId) return;
    void getChatConfig(windowId).then((cfg) => {
      setChatConfig(cfg);
      if (cfg) {
        setRecordTextPrefix(cfg.recordTextPrefix ?? '');
        setRecordTextSuffix(cfg.recordTextSuffix ?? '');
      }
    });
  }, [windowId]);

  // 初始化
  useEffect(() => {
    void initProviders().then(() => {
      // initConversations 会在 setCurrentProvider 时自动触发
    });
    // 注册流式监听
    const off = registerStreamListeners();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Provider 加载后初始化会话列表（仅首次加载 providers 时触发，切换 Provider 不重新加载）
  // 切换模型时保持当前对话和消息，用户可在同一对话中任意切换模型继续对话
  // 需求 10：会话恢复改为读取 chatConfig.lastConversationId（替代 localStorage）
  const initConversationsDoneRef = useRef(false);
  useEffect(() => {
    if (currentProviderId && !initConversationsDoneRef.current) {
      initConversationsDoneRef.current = true;
      void initConversations().then(() => {
        const state = useChatStore.getState();
        if (state.currentConversationId) return; // 已有选中对话则跳过
        // 优先恢复该窗口上次对话（需求 10：按 windowId 持久化）
        const lastConvId = chatConfig?.lastConversationId;
        if (lastConvId && state.conversations.some((c) => c.id === lastConvId)) {
          void selectConversation(lastConvId);
          return;
        }
        // 兜底：旧版 localStorage（向后兼容）
        const legacyLast = localStorage.getItem(`chat-last-conv-${currentProviderId}`);
        if (legacyLast && state.conversations.some((c) => c.id === legacyLast)) {
          void selectConversation(legacyLast);
          return;
        }
        // 无上次对话记录时，默认打开最新对话（按 updatedAt 降序取第一个）
        if (state.conversations.length > 0) {
          const sorted = [...state.conversations].sort((a, b) => {
            const ta = a.updatedAt ?? a.createdAt ?? 0;
            const tb = b.updatedAt ?? b.createdAt ?? 0;
            return tb - ta;
          });
          void selectConversation(sorted[0].id);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProviderId]);

  // 需求 10：会话切换时持久化 lastConversationId 到 chatConfig（按 windowId 隔离）
  useEffect(() => {
    if (!windowId || !chatConfig) return;
    if (currentConversationId === chatConfig.lastConversationId) return;
    const nextCfg: ChatWindowConfig = { ...chatConfig, lastConversationId: currentConversationId ?? undefined };
    setChatConfig(nextCfg);
    void updateChatDetachedWindow(windowId, nextCfg).catch((e) =>
      console.error('[ChatView] 持久化 lastConversationId 失败:', e),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversationId]);

  // 需求 10：记录文本模板变更时持久化到 chatConfig
  const persistRecordTemplate = useCallback(
    (next: { prefix: string; suffix: string }) => {
      if (!windowId || !chatConfig) return;
      const nextCfg: ChatWindowConfig = {
        ...chatConfig,
        recordTextPrefix: next.prefix || undefined,
        recordTextSuffix: next.suffix || undefined,
      };
      setChatConfig(nextCfg);
      void updateChatDetachedWindow(windowId, nextCfg).catch((e) =>
        console.error('[ChatView] 持久化记录文本模板失败:', e),
      );
    },
    [windowId, chatConfig],
  );

  // F11/F12 由主进程 attachWindowHotkeyInterceptor 在 before-input-event 中拦截处理，
  // 通过 onMaximizeToggled/onPinToggled IPC 通知更新状态（见上方监听器）。
  // 不在渲染层注册 keydown handler，避免与主进程拦截器双重执行导致状态抵消。

  // 消息更新时滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  // 6.2: 窗口重新显示时（启动/Alt+Q 唤出/快捷键唤出后）聚焦输入框
  // 使用主进程 WINDOW_SHOWN IPC 代替 window.focus 事件（后者在 hide/show 循环后不稳定），
  // 延迟 100ms 让窗口完全显示后再聚焦，避免 focus 调用被吞。
  useEffect(() => {
    const focusInput = () => {
      setTimeout(() => inputRef.current?.focus(), 100);
    };
    // IPC 通道：主进程 show/focus 后通知
    const offShown = onWindowShown(focusInput);
    // 兜底：window focus 事件（直接点击窗口时触发）
    window.addEventListener('focus', focusInput);
    focusInput();
    return () => {
      offShown();
      window.removeEventListener('focus', focusInput);
    };
  }, []);

  // 后台语音注入（Alt+V 全局快捷键，本窗口为最近聚焦窗口时收到）
  // 载荷 { text, enterToSend }：填入 textarea，enterToSend=true 时自动发送
  useEffect(() => {
    const off = onVoiceInjectAndSend(({ text, enterToSend }) => {
      console.log('[ChatView] 收到后台语音注入指令，enterToSend=', enterToSend);
      if (!text || !text.trim()) return;
      setInput((prev) => (prev ? `${prev}\n${text}` : text));
      if (enterToSend && !streaming) {
        // 异步等待 setState 生效后再发送
        setTimeout(() => {
          inputRef.current?.focus();
        }, 0);
        // 直接用最新 text 发送（避免 setState 异步导致读到旧 input）
        // 需求 10：附带记录文本模板
        void sendMessage(text, chatConfig?.systemPrompt, {
          recordTextPrefix: chatConfig?.recordTextPrefix,
          recordTextSuffix: chatConfig?.recordTextSuffix,
          tag: chatConfig?.title,
        });
        setInput('');
      } else {
        inputRef.current?.focus();
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, chatConfig]);

  // 加载 token 用量统计：初始化 + 流式结束（streaming 由 true→false）后刷新
  const refreshUsage = async () => {
    try {
      const stats = await getUsageStats(currentProviderId ?? undefined);
      setUsageStats(stats);
    } catch (e) {
      console.error('[ChatView] 加载用量统计失败:', e);
    }
  };
  useEffect(() => {
    void refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProviderId]);
  useEffect(() => {
    // 流式结束后刷新用量（streaming true→false 时触发）
    if (!streaming) void refreshUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const handleSend = async () => {
    const text = input;
    setInput('');
    // 需求 10：传递记录文本模板（前缀/后缀 + tag），主进程保存 assistant 消息前应用
    await sendMessage(text, chatConfig?.systemPrompt, {
      recordTextPrefix: chatConfig?.recordTextPrefix,
      recordTextSuffix: chatConfig?.recordTextSuffix,
      tag: chatConfig?.title,
    });
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡触发路由回退（需求 14）
      if (!streaming) void handleSend();
    }
  };

  const handleMaximize = async () => {
    const next = await maximizeToggleWindow();
    setIsMaximized(next);
  };

  const handleSelectConversation = async (id: string) => {
    await selectConversation(id);
    if (isNarrow) setIsSidebarOpen(false);
  };

  const handleNewConversation = async () => {
    await startNewConversation();
    if (isNarrow) setIsSidebarOpen(false);
    // 若配置了默认提示词，自动作为首条 user 消息发送（连同 systemPrompt）
    const dp = chatConfig?.defaultPrompt?.trim();
    if (dp && currentProviderId && !streaming) {
      await sendMessage(dp, chatConfig?.systemPrompt, {
        recordTextPrefix: chatConfig?.recordTextPrefix,
        recordTextSuffix: chatConfig?.recordTextSuffix,
        tag: chatConfig?.title,
      });
    }
  };

  const currentProvider = providers.find((p) => p.id === currentProviderId);

  // chat 脱离窗口：加载 chatConfig 后自动切换到绑定的 provider（仅首次）
  useEffect(() => {
    if (chatConfig?.providerId && providers.length > 0 && currentProviderId !== chatConfig.providerId) {
      const exists = providers.some((p) => p.id === chatConfig.providerId);
      if (exists) setCurrentProvider(chatConfig.providerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatConfig, providers]);

  // 根据样式配置计算 CSS 变量与数据属性
  const style: ChatWindowStyle = chatConfig?.style ?? {};
  const cssVars = useMemo(() => {
    const vars: Record<string, string> = {};
    if (style.accentColor) {
      vars['--accent'] = style.accentColor;
      vars['--accent-bright'] = style.accentColor;
      vars['--accent-dim'] = style.accentColor;
    }
    return vars;
  }, [style.accentColor]);
  const density = style.density ?? 'comfortable';
  const showAvatar = style.showAvatar !== false; // 默认 true
  const showTimestamp = style.showTimestamp !== false; // 默认 true
  const codeTheme = style.codeTheme ?? 'github-dark';

  return (
    <>
      <WindowResizeHandles />
      <div
        className="chat-view app-shell app-view-root"
        data-viewport={isNarrow ? 'narrow' : 'wide'}
        data-density={density}
        data-code-theme={codeTheme}
        data-name="chat.container"
        style={cssVars}
      >
        {/* 顶栏：统一 TitleBar 组件，替代原 .chat-top 自定义结构 */}
        <TitleBar
          maximized={isMaximized}
          onMinimize={() => void minimizeWindow()}
          onMaximize={handleMaximize}
          onClose={() => void closeCurrentWindow()}
          leading={
            <IconButton
              type="button"
              className="chat-sidebar-toggle titlebar-icon-btn"
              data-name="chat.top-bar.sidebar-toggle-icon-button"
              aria-label="会话列表"
              title="会话列表"
              onClick={() => {
                if (isNarrow) setIsSidebarOpen((v) => !v);
                else setIsSidebarCollapsed((v) => !v);
              }}
            >
              <svg className="icon-svg" data-name="chat.top-bar.sidebar-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </IconButton>
          }
          center={
            <div className="chat-top-drag" data-name="chat.top-bar.drag-area">
              <span className="chat-top-title" data-name="chat.top-bar.title">{chatConfig?.title || 'AI 对话'}</span>
              {providers.length > 0 ? (
                <select
                  className="chat-provider-select"
                  data-name="chat.top-bar.provider-select"
                  value={currentProviderId ?? ''}
                  onChange={(e) => setCurrentProvider(e.target.value)}
                  title="切换 AI 提供商"
                >
                  {providers.map((p, idx) => (
                    <option key={p.id} value={p.id} data-name={`chat.top-bar.provider-option-${idx + 1}`}>
                      {p.name} ({p.model})
                    </option>
                  ))}
                </select>
              ) : (
                <span data-name="chat.top-bar.no-provider-text" style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                  未配置提供商
                </span>
              )}
              {usageStats && usageStats.todayTokens > 0 && (
                <span
                  className="chat-usage-badge"
                  data-name="chat.top-bar.usage-badge"
                  title={`今日 ${usageStats.todayTokens} tokens / 共 ${usageStats.totalTokens} tokens`}
                >
                  今日 {usageStats.todayTokens} tok
                </span>
              )}
            </div>
          }
          actions={
            <>
              <IconButton
                type="button"
                data-name="chat.top-bar.settings-icon-button"
                aria-label="设置"
                title="设置"
                onClick={() => void openAiAppProviderWindow(currentProviderId ?? undefined)}
              >
                <svg className="icon-svg" data-name="chat.top-bar.settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </IconButton>
              <IconButton
                type="button"
                variant={isPinned ? 'active' : 'default'}
                data-name="chat.top-bar.pin-icon-button"
                aria-label={isPinned ? '取消置顶' : '置顶'}
                title={isPinned ? '取消置顶' : '置顶'}
                onClick={async () => {
                  const next = !isPinned;
                  setIsPinned(next);
                  await pinCurrentWindow(next);
                }}
              >
                <svg className="icon-svg" data-name="chat.top-bar.pin-icon" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                </svg>
              </IconButton>
            </>
          }
        />

        {/* 主体 */}
        <div className="chat-body" data-name="chat.body">
          {/* 窄屏遮罩 */}
          <div
            className={`chat-sidebar-overlay${isSidebarOpen ? ' show' : ''}`}
            data-name="chat.sidebar.overlay"
            onClick={() => setIsSidebarOpen(false)}
          />
          {/* 侧边会话列表 */}
          <aside className={`chat-sidebar${isNarrow && isSidebarOpen ? ' open' : ''}${isSidebarCollapsed ? ' collapsed' : ''}`} data-name="chat.sidebar.container">
            <div className="chat-sidebar-head" data-name="chat.sidebar.head">
              <Button
                variant="ghost"
                type="button"
                className="chat-new-btn"
                data-name="chat.sidebar.new-conversation-button"
                onClick={handleNewConversation}
              >
                <svg className="icon-svg" data-name="chat.sidebar.new-conversation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                新建对话
              </Button>
            </div>
            <div className="chat-conv-list" data-name="chat.sidebar.conversation-list">
              {conversations.length === 0 ? (
                <div className="chat-conv-empty" data-name="chat.sidebar.conversation-list-empty">
                  暂无历史对话
                </div>
              ) : (
                conversations.map((c, idx) => (
                  <div
                    key={c.id}
                    data-name={`chat.sidebar.conversation-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={c.id}
                    className={`chat-conv-item${c.id === currentConversationId ? ' active' : ''}`}
                    onClick={() => void handleSelectConversation(c.id)}
                  >
                    <span className="chat-conv-title" data-name="chat.sidebar.conversation-title">{c.title || '新对话'}</span>
                    <IconButton
                      type="button"
                      className="chat-conv-export"
                      data-name="chat.sidebar.export-md-icon-button"
                      aria-label="导出为 Markdown"
                      title="导出为 Markdown"
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportConversation(c.id, 'md').catch((err) =>
                          console.error('[ChatView] 导出 MD 失败:', err),
                        );
                      }}
                    >
                      MD
                    </IconButton>
                    <IconButton
                      type="button"
                      className="chat-conv-export"
                      data-name="chat.sidebar.export-json-icon-button"
                      aria-label="导出为 JSON"
                      title="导出为 JSON"
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportConversation(c.id, 'json').catch((err) =>
                          console.error('[ChatView] 导出 JSON 失败:', err),
                        );
                      }}
                    >
                      JSON
                    </IconButton>
                    <IconButton
                      type="button"
                      variant="close"
                      className="chat-conv-del"
                      data-name="chat.sidebar.delete-conversation-icon-button"
                      aria-label="删除对话"
                      title="删除对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeConversation(c.id);
                      }}
                    >
                      <svg className="icon-svg-sm" data-name="chat.sidebar.delete-conversation-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    </IconButton>
                  </div>
                ))
              )}
            </div>
          </aside>

          {/* 消息区 + 输入区 */}
          <main className="chat-main" data-name="chat.main">
            <div className="chat-messages" data-name="chat.messages-container">
              {messages.length === 0 && !streaming ? (
                <div className="chat-empty" data-name="chat.empty-state">
                  <div className="chat-empty-icon" data-name="chat.empty-state-icon">AI</div>
                  <div data-name="chat.empty-state-text">
                    {currentProvider
                      ? `与 ${currentProvider.name} 开始对话`
                      : '请在设置中配置 AI 提供商'}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      providerName={currentProvider?.name}
                      showAvatar={showAvatar}
                      showTimestamp={showTimestamp}
                      onEdit={editMessage}
                      onRetry={retryLastMessage}
                      onContinue={continueGeneration}
                    />
                  ))}
                  {streaming && streamingText && (
                    <MessageBubble
                      message={{
                        id: 'streaming',
                        conversationId: currentConversationId ?? '',
                        role: 'assistant',
                        content: streamingText,
                        createdAt: Date.now(),
                      }}
                      streaming
                      providerName={currentProvider?.name}
                      showAvatar={showAvatar}
                      showTimestamp={showTimestamp}
                    />
                  )}
                  {streaming && !streamingText && (
                    <div className="chat-msg-row assistant" data-name="chat.thinking-indicator">
                      <div className="chat-avatar assistant" data-name="chat.thinking-avatar">
                        {currentProvider?.name?.charAt(0).toUpperCase() || 'AI'}
                      </div>
                      <div className="chat-msg-content" data-name="chat.thinking-content">
                        <div className="chat-thinking" data-name="chat.thinking-dots">
                          <span className="chat-thinking-dot" data-name="chat.thinking-dot-1" />
                          <span className="chat-thinking-dot" data-name="chat.thinking-dot-2" />
                          <span className="chat-thinking-dot" data-name="chat.thinking-dot-3" />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} data-name="chat.messages-end-anchor" />
                </>
              )}
            </div>

            {streamError && <div className="chat-error-bar" data-name="chat.error-bar">⚠ {streamError}</div>}

            {/* 需求 10：记录文本模板折叠面板 */}
            <div className="chat-record-template" data-name="chat.record-template-panel">
              <button
                type="button"
                className="chat-record-template-toggle"
                data-name="chat.record-template-toggle-button"
                onClick={() => setShowRecordTemplate((v) => !v)}
              >
                {showRecordTemplate ? '▾' : '▸'} 记录文本模板
              </button>
              {showRecordTemplate && (
                <div className="chat-record-template-body" data-name="chat.record-template-body">
                  <div className="chat-record-template-row" data-name="chat.record-template-prefix-row">
                    <label className="chat-record-template-label" data-name="chat.record-template-prefix-label">前缀</label>
                    <input
                      type="text"
                      className="chat-record-template-input"
                      data-name="chat.record-template-prefix-input"
                      placeholder="例如：[{{time}}] "
                      value={recordTextPrefix}
                      onChange={(e) => setRecordTextPrefix(e.target.value)}
                      onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                    />
                  </div>
                  <div className="chat-record-template-row" data-name="chat.record-template-suffix-row">
                    <label className="chat-record-template-label" data-name="chat.record-template-suffix-label">后缀</label>
                    <input
                      type="text"
                      className="chat-record-template-input"
                      data-name="chat.record-template-suffix-input"
                      placeholder="例如：——{{tag}}"
                      value={recordTextSuffix}
                      onChange={(e) => setRecordTextSuffix(e.target.value)}
                      onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                    />
                  </div>
                  <div className="chat-record-template-hint" data-name="chat.record-template-hint">
                    占位符：<code>{'{{time}}'}</code> 当前时间；<code>{'{{tag}}'}</code> 窗口标题。仅影响保存的 AI 回复，不改变实时显示。
                  </div>
                </div>
              )}
            </div>

            <div className="chat-input-area" data-name="chat.input-area">
              <div className="chat-input-wrap" data-name="chat.input-wrap">
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  data-name="chat.input-textarea"
                  placeholder={currentProvider ? `向 ${currentProvider.name} 发送消息...` : '请先配置 AI 提供商'}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!currentProvider}
                  rows={1}
                />
              </div>
              {streaming ? (
                <button
                  type="button"
                  className="btn-primary-flat chat-send-btn cancel"
                  data-name="chat.stop-button"
                  onClick={() => void cancelStream()}
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-primary-flat chat-send-btn"
                  data-name="chat.send-button"
                  onClick={() => void handleSend()}
                  disabled={!currentProvider || !input.trim()}
                >
                  <svg className="icon-svg" data-name="chat.send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  发送
                </button>
              )}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
