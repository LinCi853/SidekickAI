/* =====================================================================
   pages/AdvancedPanelChatTab.tsx —— 进阶面板「自定义对话」tab
   会话列表 + 消息区（复用 useChatStore），从 AdvancedPanelView.tsx 拆出；
   仅通过 props（onOpenSettings）与主视图交互，逻辑保持原样。
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../store/useChatStore';
import SidebarShell from '../components/SidebarShell';
import { IconButton, Combobox } from '../components/ui';
import type { ComboboxOption } from '../components/ui';
import { MessageBubble } from './MessageBubble';
import {
  getAppSettings,
  updateAppSettings,
  resizeWindow,
} from '../lib/electron-api';
import { MAIN_WINDOW_MIN_HEIGHT } from '../../electron/shared/window-size';

/**
 * 流式气泡：单独订阅 streamingText，每个 chunk 只重渲染这一个气泡并负责滚动；
 * thinking 占位（尚无文本时）也在这里切换。
 */
function StreamingMessageBubble({ conversationId, endRef }: {
  conversationId: string;
  endRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const streamingText = useChatStore((s) => s.streamingText);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [streamingText, endRef]);
  if (!streamingText) {
    return (
      <div className="chat-msg-row assistant" data-name="advanced-panel.chat-thinking">
        <div className="chat-avatar assistant">AI</div>
        <div className="chat-thinking" data-name="advanced-panel.chat-thinking-dots">
          <span className="chat-thinking-dot" />
          <span className="chat-thinking-dot" />
          <span className="chat-thinking-dot" />
        </div>
      </div>
    );
  }
  return (
    <MessageBubble
      message={{
        id: 'streaming',
        conversationId,
        role: 'assistant',
        content: streamingText,
        createdAt: Date.now(),
      }}
      streaming
    />
  );
}

export function ChatTab({ onOpenSettings }: { onOpenSettings: () => void }) {
  // useShallow 选择器订阅：排除 streamingText，流式期间每个 chunk 只重渲染
  // StreamingMessageBubble，不让整个 tab 与历史消息气泡跟着重渲染。
  const {
    providers,
    currentProviderId,
    conversations,
    currentConversationId,
    messages,
    streaming,
    streamError,
    initProviders,
    initConversations,
    setCurrentProvider,
    editProvider,
    selectConversation,
    startNewConversation,
    removeConversation,
    sendMessage,
    cancelStream,
    registerStreamListeners,
  } = useChatStore(useShallow((s) => ({
    providers: s.providers,
    currentProviderId: s.currentProviderId,
    conversations: s.conversations,
    currentConversationId: s.currentConversationId,
    messages: s.messages,
    streaming: s.streaming,
    streamError: s.streamError,
    initProviders: s.initProviders,
    initConversations: s.initConversations,
    setCurrentProvider: s.setCurrentProvider,
    editProvider: s.editProvider,
    selectConversation: s.selectConversation,
    startNewConversation: s.startNewConversation,
    removeConversation: s.removeConversation,
    sendMessage: s.sendMessage,
    cancelStream: s.cancelStream,
    registerStreamListeners: s.registerStreamListeners,
  })));

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorPosRef = useRef<number>(0);
  // 侧边栏宽度/收起状态
  const [sidebarWidth, setSidebarWidth] = useState(130);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 窗口是否过窄（宽度 < 主窗口最小高度时隐藏模型选择器）
  const [isNarrowWindow, setIsNarrowWindow] = useState(false);

  // 监听窗口宽度，动态判断是否过窄（宽度 < 主窗口最小高度 * 1.5 时隐藏模型选择器）
  useEffect(() => {
    const checkNarrow = () => {
      setIsNarrowWindow(window.innerWidth < MAIN_WINDOW_MIN_HEIGHT * 1.5);
    };
    checkNarrow();
    window.addEventListener('resize', checkNarrow);
    return () => window.removeEventListener('resize', checkNarrow);
  }, []);

  // 初始化 providers + 流式监听
  useEffect(() => {
    void initProviders();
    const off = registerStreamListeners();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动聚焦输入框并恢复光标位置
  useEffect(() => {
    void getAppSettings().then((cfg) => {
      const savedPos = cfg.chatInputCursorPos ?? 0;
      cursorPosRef.current = savedPos;
      requestAnimationFrame(() => {
        const ta = inputRef.current;
        if (!ta) return;
        ta.focus();
        const pos = Math.min(savedPos, ta.value.length);
        ta.setSelectionRange(pos, pos);
      });
    }).catch(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, []);

  // 读取侧边栏宽度/收起设置
  useEffect(() => {
    void getAppSettings()
      .then((cfg) => {
        setSidebarWidth(cfg.chatSidebarWidth ?? 130);
        setSidebarCollapsed(cfg.chatSidebarCollapsed ?? false);
      })
      .catch(() => {});
  }, []);

  // 侧边栏拖拽调宽：即时更新状态，松开时持久化
  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w);
    void updateAppSettings({ chatSidebarWidth: w });
  }, []);

  // 侧边栏收起/展开切换：窄窗口展开时自动扩展宽度
  const handleSidebarToggleCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    void updateAppSettings({ chatSidebarCollapsed: next });
    // 展开侧边栏时，如果窗口太窄，自动扩展到合适的宽度
    if (next === false) {
      const currentWidth = window.innerWidth;
      const targetWidth = sidebarWidth + 500; // 侧边栏 + 内容区最小宽度
      if (currentWidth < targetWidth) {
        void resizeWindow({ width: targetWidth, height: window.innerHeight });
      }
    }
  }, [sidebarCollapsed, sidebarWidth]);

  // provider 加载后初始化会话列表
  useEffect(() => {
    if (currentProviderId) {
      void initConversations().then(() => {
        const state = useChatStore.getState();
        if (state.currentConversationId) return;
        // 恢复上次会话
        const last = localStorage.getItem(`chat-last-conv-${currentProviderId}`);
        if (last && state.conversations.some((c) => c.id === last)) {
          void state.selectConversation(last);
          return;
        }
        // 无上次记录时，默认打开最新对话（按 updatedAt 降序）
        if (state.conversations.length > 0) {
          const sorted = [...state.conversations].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
          void state.selectConversation(sorted[0].id);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProviderId]);

  // 自动聚焦输入框（组件挂载时，即窗口打开 / 切换到 chat tab 时）
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // 消息列表自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 保存光标位置到设置：仅用于恢复焦点，内存 ref 即时更新；
  // 写盘防抖 500ms——每次按键都全量读+写 settings 并向所有窗口广播
  // APP_SETTINGS_CHANGED 会形成持续 IO/广播风暴
  const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveCursorPos = useCallback((pos: number) => {
    cursorPosRef.current = pos;
    if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
    cursorSaveTimerRef.current = setTimeout(() => {
      cursorSaveTimerRef.current = undefined;
      void updateAppSettings({ chatInputCursorPos: cursorPosRef.current }).catch(() => {});
    }, 500);
  }, []);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput('');
    saveCursorPos(0);
    await sendMessage(trimmed, undefined);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡触发路由回退（需求 14）
      void handleSend();
    }
  };

  const currentProvider = providers.find((p) => p.id === currentProviderId);

  // 两个模型选择器（侧边栏 + 输入区）共享同一套 options 和 onSelect
  const modelSelectOptions = providers.flatMap<ComboboxOption>((p) => {
    const models = [p.model, ...(p.alternativeModels ?? [])];
    return models.map((m) => ({
      value: `${p.id}::${m}`,
      label: m,
      selected: p.id === currentProviderId && p.model === m,
    }));
  });
  const handleModelSelect = async (v: string) => {
    const sepIdx = v.indexOf('::');
    if (sepIdx < 0) return;
    const pid = v.slice(0, sepIdx);
    const modelName = v.slice(sepIdx + 2);
    const target = providers.find((p) => p.id === pid);
    if (!target) return;
    if (pid !== currentProviderId) setCurrentProvider(pid);
    if (target.model !== modelName) {
      const alts = target.alternativeModels ?? [];
      const newAlts = alts.includes(modelName)
        ? [...alts.filter((m) => m !== modelName), target.model]
        : [...alts, target.model];
      await editProvider(pid, { model: modelName, alternativeModels: newAlts });
    }
  };

  return (
    <div className="advanced-panel-chat" data-name="advanced-panel.chat">
      {/* 左侧：provider 选择 + 会话列表 */}
      <SidebarShell
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onResize={handleSidebarResize}
        onToggleCollapse={handleSidebarToggleCollapse}
        onOpenSettings={onOpenSettings}
        onNew={startNewConversation}
        newTitle="新建对话"
        collapsedItems={conversations.map((c) => ({
          id: c.id,
          label: c.title || '未命名对话',
          active: c.id === currentConversationId,
          onClick: () => void selectConversation(c.id),
        }))}
        collapsedHeader={
          <Combobox
            inputValue="M"
            onInputChange={() => {}}
            inputClassName="sidebar-shell-collapsed-select"
            inputReadOnly
            disabled={providers.length === 0}
            options={modelSelectOptions}
            onSelect={handleModelSelect}
            searchable
            searchPlaceholder="搜索模型…"
            emptyText="无匹配模型"
            panelClassName="advanced-panel-chat-provider-panel"
            dataName="advanced-panel.chat-sidebar-model-select"
          />
        }
        dataName="advanced-panel.chat-sidebar"
        header={
          <div className="advanced-panel-chat-provider sidebar-shell-header" data-name="advanced-panel.chat-provider">
            <Combobox
              inputValue={currentProvider?.model ?? ''}
              onInputChange={() => {}}
              inputPlaceholder="选择模型"
              inputClassName="advanced-panel-chat-provider-select"
              inputReadOnly
              disabled={providers.length === 0}
              options={modelSelectOptions}
              onSelect={handleModelSelect}
              searchable
              searchPlaceholder="搜索模型…"
              emptyText="无匹配模型"
              panelClassName="advanced-panel-chat-provider-panel"
              dataName="advanced-panel.chat-provider-select"
            />
            <IconButton
              type="button"
              className="sidebar-shell-new-btn"
              onClick={startNewConversation}
              title="新建对话"
              aria-label="新建对话"
              data-name="advanced-panel.chat-new-conversation-button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </IconButton>
          </div>
        }
      >
        <div className="sidebar-shell-list" data-name="advanced-panel.chat-conv-list">
          {conversations.length === 0 && (
            <div className="advanced-panel-chat-empty" data-name="advanced-panel.chat-conv-empty">暂无对话</div>
          )}
          {conversations.map((c, idx) => (
            <div
              key={c.id}
              className={`advanced-panel-chat-conv-item${c.id === currentConversationId ? ' active' : ''}`}
              data-name={`advanced-panel.chat-conv-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={c.id}
            >
              <button
                type="button"
                className="advanced-panel-chat-conv-main"
                onClick={() => void selectConversation(c.id)}
                title={c.title}
                data-name={`advanced-panel.chat-conv-item-${idx + 1}-main`}
              >
                <span className="advanced-panel-chat-conv-title" data-name={`advanced-panel.chat-conv-item-${idx + 1}-title`}>{c.title || '未命名对话'}</span>
              </button>
              <IconButton
                type="button"
                className="advanced-panel-chat-conv-del"
                onClick={() => void removeConversation(c.id)}
                title="删除对话"
                aria-label="删除对话"
                data-name={`advanced-panel.chat-conv-item-${idx + 1}-delete-button`}
              >
                ×
              </IconButton>
            </div>
          ))}
        </div>
      </SidebarShell>

      {/* 右侧：消息区 + 输入框 */}
      <section className="advanced-panel-chat-main" data-name="advanced-panel.chat-main">
        <div className="advanced-panel-chat-messages" data-name="advanced-panel.chat-messages">
          {messages.length === 0 && !streaming && (
            <div className="advanced-panel-chat-placeholder" data-name="advanced-panel.chat-placeholder">
              {currentProvider ? `开始与 ${currentProvider.name} 对话` : '请先在「自定义供应商」页配置供应商'}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} streaming={streaming && m.id === messages[messages.length - 1]?.id} />
          ))}
          {streaming && (
            <StreamingMessageBubble conversationId={currentConversationId ?? ''} endRef={messagesEndRef} />
          )}
          {streamError && (
            <div className="advanced-panel-chat-error" data-name="advanced-panel.chat-error">{streamError}</div>
          )}
          <div ref={messagesEndRef} data-name="advanced-panel.chat-messages-end" />
        </div>
        <div className="advanced-panel-chat-input-wrap" data-name="advanced-panel.chat-input-wrap">
          {!isNarrowWindow && (
            <Combobox
              inputValue={currentProvider?.model ?? ''}
              onInputChange={() => {}}
              inputPlaceholder="模型"
              inputClassName="advanced-panel-chat-model-select"
              inputReadOnly
              disabled={providers.length === 0}
              options={modelSelectOptions}
              onSelect={handleModelSelect}
              searchable
              searchPlaceholder="搜索模型…"
              emptyText="无匹配模型"
              panelClassName="advanced-panel-chat-model-panel"
              dataName="advanced-panel.chat-input-model-select"
            />
          )}
          <textarea
            ref={inputRef}
            className="advanced-panel-chat-input"
            value={input}
            placeholder={currentProvider ? `发送给 ${currentProvider.name}...` : '请先选择供应商'}
            onChange={(e) => {
              setInput(e.target.value);
              saveCursorPos(e.target.selectionStart);
            }}
            onSelect={(e) => saveCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
            onClick={(e) => saveCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!currentProviderId}
            data-name="advanced-panel.chat-input-textarea"
          />
          <div className="advanced-panel-chat-input-actions" data-name="advanced-panel.chat-input-actions">
            <IconButton
              type="button"
              className="sidebar-shell-new-btn"
              onClick={startNewConversation}
              title="新建对话"
              aria-label="新建对话"
              data-name="advanced-panel.chat-input-new-button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </IconButton>
            {streaming ? (
              <button type="button" className="btn-primary-flat advanced-panel-chat-send cancel" onClick={() => void cancelStream()} data-name="advanced-panel.chat-stop-button">停止</button>
            ) : (
              <button
                type="button"
                className="btn-primary-flat advanced-panel-chat-send"
                onClick={() => void handleSend()}
                disabled={!input.trim() || !currentProviderId}
                data-name="advanced-panel.chat-send-button"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
