/* =====================================================================
   pages/AiProviderAppView.tsx —— AI 应用独立窗口主视图
   架构：
   - 顶栏：tab 切换（自定义供应商 / 自定义对话）+ 窗口控制（最小化/最大化/关闭）
   - 主体：根据 activeTab 渲染两个子页面
     · providers  —— 自定义供应商管理（添加/编辑/删除/测试，复用 useChatStore 的 provider 管理）
     · chat       —— 自定义对话（复用 useChatStore 的会话/流式；左侧会话列表 + 右侧消息区）
   - 通过 URL 查询参数 ?mode=ai-app-provider[&provider=...&tab=...] 接收初始状态
   - 主进程通过 'ai-app-provider:navigate' 事件通知切换 tab/provider（单例窗口复用时）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { useChatStore } from '../store/useChatStore';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  onAiAppProviderNavigate,
  pinCurrentWindow,
  listAIProviderModels,
  exportAIProvidersEncrypted,
  importAIProvidersEncrypted,
  // v0.5.2 B-4：文件对话框 + 预览导入 + 文件读写
  selectAIProviderExportPath,
  selectAIProviderImportFile,
  writeAIProviderExportFile,
  readAIProviderImportFile,
  previewImportAIProviders,
  // 白板跨窗口推送（v0.5.1：订阅提升到顶层，解决 WhiteboardView 未挂载时卡片丢失）
  onWhiteboardPushCard,
  pushWhiteboardAck,
} from '../lib/electron-api';
import type {
  CustomAIProvider,
  CustomAIProviderInput,
  WhiteboardCard,
} from '../lib/electron-api';
import Badge from '../components/ui/Badge';
import { Button, IconButton, SegmentedControl, TitleBar } from '../components/ui';
import AiAppSettingsPanel from '../components/AiAppSettingsPanel';
import { MessageBubble } from './MessageBubble';
import WhiteboardView from './WhiteboardView';
import type { WhiteboardViewHandle } from './WhiteboardView';
import NotesView from './NotesView';
import { useWindowMaximizedAndPinned } from '../hooks/useWindowMaximizedAndPinned';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import './AiProviderAppView.css';

type TabKey = 'chat' | 'whiteboard' | 'notes';

/** 从 URL 查询参数读取初始 tab */
function readInitialTab(): TabKey {
  if (typeof window === 'undefined') return 'chat';
  const t = new URLSearchParams(window.location.search).get('tab');
  if (t === 'whiteboard' || t === 'notes') return t;
  return 'chat';
}

/** 从 URL 查询参数读取初始 providerId */
function readInitialProviderId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('provider');
}

export default function AiProviderAppView() {
  const [activeTab, setActiveTab] = useState<TabKey>(readInitialTab);
  const { isMaximized, isPinned, setIsMaximized, setIsPinned } = useWindowMaximizedAndPinned();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialProviderId = useMemo(() => readInitialProviderId(), []);

  // ===== 白板跨窗口推送管理（v0.5.1：订阅提升到顶层） =====
  // WhiteboardView 仅在 activeTab === 'whiteboard' 时挂载，
  // 但截图推送可能发生在任意 tab。订阅放顶层确保不丢失。
  const whiteboardRef = useRef<WhiteboardViewHandle>(null);
  // 待插入的推送卡片队列：WhiteboardView 未挂载或未 ready 时暂存
  const pendingPushCardsRef = useRef<Array<{ whiteboardId: string; card: WhiteboardCard }>>([]);

  // 监听主进程的 navigate 事件（单例窗口复用时切换 tab/provider）
  useEffect(() => {
    return onAiAppProviderNavigate((payload) => {
      setActiveTab(payload.tab);
      if (payload.providerId) {
        useChatStore.getState().setCurrentProvider(payload.providerId);
      }
    });
  }, []);

  // 初始化时若 URL 指定了 provider，切换 chat tab 并选中该 provider
  useEffect(() => {
    if (initialProviderId) {
      setActiveTab('chat');
      useChatStore.getState().setCurrentProvider(initialProviderId);
    }
  }, [initialProviderId]);

  // activeTab 的 ref，供订阅回调同步读取（避免闭包陈旧）
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  /** 尝试将待推送队列中的卡片插入到白板 canvas */
  const flushPendingPushCards = useCallback(() => {
    const wb = whiteboardRef.current;
    if (!wb || !wb.isReady()) return;
    const pending = pendingPushCardsRef.current;
    if (pending.length === 0) return;
    pendingPushCardsRef.current = [];
    for (const { card } of pending) {
      wb.insertCard(card);
    }
    // flush 后回 ACK，通知主进程可以继续推送
    pushWhiteboardAck();
  }, []);

  // ===== 白板跨窗口推送订阅（始终活跃，不受 tab 切换影响） =====
  useEffect(() => {
    const unsubscribe = onWhiteboardPushCard((payload) => {
      const { whiteboardId, card } = payload;
      // 入队待插入卡片
      pendingPushCardsRef.current.push({ whiteboardId, card });
      // 确保切换到白板 tab（若不在）
      if (activeTabRef.current !== 'whiteboard') {
        setActiveTab('whiteboard');
      } else {
        // 已在白板 tab，尝试立即 flush
        flushPendingPushCards();
      }
    });
    return unsubscribe;
  }, [flushPendingPushCards]);

  // activeTab 变为 whiteboard 时，若 canvas 已 ready 则 flush；否则等 onReady 触发
  useEffect(() => {
    if (activeTab === 'whiteboard') {
      // canvas 可能刚挂载，需等 onReady；也可能已挂载（tab 切回），直接 flush
      // 延迟一帧让 ref 就绪
      const timer = setTimeout(() => flushPendingPushCards(), 50);
      return () => clearTimeout(timer);
    }
  }, [activeTab, flushPendingPushCards]);

  // WhiteboardView canvas ready 回调：flush 待推送队列 + 回 ACK
  const handleWhiteboardReady = useCallback(() => {
    // 回 ACK 通知主进程白板已就绪（无论是否有待推送卡片）
    pushWhiteboardAck();
    flushPendingPushCards();
  }, [flushPendingPushCards]);

  // ESC：设置面板/Modal 打开时逐级关闭，否则关闭窗口
  useEscToCloseWindow({
    onEsc: (e) => {
      // 检查是否有 Modal 打开（ui/Modal 的 .modal-overlay）
      if (document.querySelector('.modal-overlay')) {
        // Modal 自带 ESC 关闭逻辑，这里不重复处理
        return true;
      }
      // 检查设置面板是否打开
      if (settingsOpen) {
        e.preventDefault();
        setSettingsOpen(false);
        return true;
      }
      return false;
    },
  });

  const handleMinimize = useCallback(() => void minimizeWindow().catch(() => {}), []);
  const handleMaximize = useCallback(() => {
    void maximizeToggleWindow()
      .then(setIsMaximized)
      .catch(() => {});
  }, []);
  const handleClose = useCallback(() => void closeCurrentWindow().catch(() => {}), []);

  return (
    <div className="ai-app-provider-view app-shell app-view-root" data-name="ai-app-provider.container">
      <TitleBar
        maximized={isMaximized}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
        center={
          <SegmentedControl<TabKey>
            value={activeTab}
            onChange={setActiveTab}
            name="ai-app-tab"
            className="ai-app-segmented"
            options={[
              { value: 'chat', label: '自定义对话' },
              { value: 'whiteboard', label: '白板' },
              { value: 'notes', label: '灵感笔记' },
            ]}
          />
        }
        actions={
          <>
            <IconButton
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="设置"
              data-name="ai-app-provider.topbar-settings-button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-settings-icon">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </IconButton>
            <IconButton
              type="button"
              variant={isPinned ? 'active' : 'default'}
              onClick={async () => {
                const next = !isPinned;
                setIsPinned(next);
                try { await pinCurrentWindow(next); } catch { setIsPinned(!next); }
              }}
              title={isPinned ? '取消置顶' : '置顶'}
              aria-label={isPinned ? '取消置顶' : '置顶'}
              data-name="ai-app-provider.topbar-pin-button"
            >
              <svg viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-pin-icon">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
          </>
        }
      />
      <div className="ai-app-provider-body" data-name="ai-app-provider.body">
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'whiteboard' && (
          <WhiteboardView
            ref={whiteboardRef}
            onClose={() => setActiveTab('chat')}
            onReady={handleWhiteboardReady}
          />
        )}
        {activeTab === 'notes' && <NotesView />}
      </div>
      <AiAppSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <WindowResizeHandles />
    </div>
  );
}

/* =====================================================================
   「自定义对话」tab —— 会话列表 + 消息区（复用 useChatStore）
   ===================================================================== */
function ChatTab() {
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
    registerStreamListeners,
  } = useChatStore();

  const [input, setInput] = useState('');
  // 需求 10：记录文本模板（ChatTab 为全局单例 tab，使用 localStorage 持久化）
  const [showRecordTemplate, setShowRecordTemplate] = useState(false);
  const [recordTextPrefix, setRecordTextPrefix] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('chat-tab-record-prefix') ?? '';
  });
  const [recordTextSuffix, setRecordTextSuffix] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('chat-tab-record-suffix') ?? '';
  });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 需求 10：模板字段变更时持久化到 localStorage
  const persistRecordTemplate = (next: { prefix: string; suffix: string }) => {
    try {
      localStorage.setItem('chat-tab-record-prefix', next.prefix);
      localStorage.setItem('chat-tab-record-suffix', next.suffix);
    } catch (e) {
      console.warn('[ChatTab] 持久化记录文本模板失败:', e);
    }
  };

  // 初始化 providers + 流式监听
  useEffect(() => {
    void initProviders();
    const off = registerStreamListeners();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [messages, streamingText]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput('');
    // 需求 10：传递记录文本模板（前缀/后缀 + tag=provider 名），主进程保存 assistant 消息前应用
    await sendMessage(trimmed, undefined, {
      recordTextPrefix: recordTextPrefix || undefined,
      recordTextSuffix: recordTextSuffix || undefined,
      tag: currentProvider?.name,
    });
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

  return (
    <div className="ai-app-chat" data-name="ai-app-provider.chat">
      {/* 左侧：provider 选择 + 会话列表 */}
      <aside className="ai-app-chat-sidebar" data-name="ai-app-provider.chat-sidebar">
        <div className="ai-app-chat-provider" data-name="ai-app-provider.chat-provider">
          <label className="ai-app-chat-provider-label" data-name="ai-app-provider.chat-provider-label">当前模型</label>
          <div className="ai-app-chat-provider-selector" data-name="ai-app-provider.chat-provider-selector">
            <select
              className="ai-app-chat-provider-select"
              value={currentProviderId ?? ''}
              onChange={(e) => setCurrentProvider(e.target.value)}
              disabled={providers.length === 0}
              data-name="ai-app-provider.chat-provider-select"
            >
              {providers.length === 0 && <option value="" data-name="ai-app-provider.chat-provider-select-empty-option">未配置供应商</option>}
              {providers.map((p, idx) => (
                <option key={p.id} value={p.id} data-name={`ai-app-provider.chat-provider-select-option-${idx + 1}`} data-index={idx + 1} data-id={p.id}>{p.name} · {p.model}</option>
              ))}
            </select>
            <svg className="ai-app-chat-provider-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-provider.chat-provider-arrow-icon">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          {currentProvider && (
            <div className="ai-app-chat-provider-meta" data-name="ai-app-provider.chat-provider-meta">{currentProvider.model}</div>
          )}
        </div>
        <Button type="button" variant="ghost" className="ai-app-chat-new" onClick={startNewConversation} data-name="ai-app-provider.chat-new-conversation-button">+ 新建对话</Button>
        <div className="ai-app-chat-conv-list" data-name="ai-app-provider.chat-conv-list">
          {conversations.length === 0 && (
            <div className="ai-app-chat-empty" data-name="ai-app-provider.chat-conv-empty">暂无对话</div>
          )}
          {conversations.map((c, idx) => (
            <div
              key={c.id}
              className={`ai-app-chat-conv-item${c.id === currentConversationId ? ' active' : ''}`}
              data-name={`ai-app-provider.chat-conv-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={c.id}
            >
              <button
                type="button"
                className="ai-app-chat-conv-main"
                onClick={() => void selectConversation(c.id)}
                title={c.title}
                data-name={`ai-app-provider.chat-conv-item-${idx + 1}-main`}
              >
                <span className="ai-app-chat-conv-title" data-name={`ai-app-provider.chat-conv-item-${idx + 1}-title`}>{c.title || '未命名对话'}</span>
              </button>
              <IconButton
                type="button"
                className="ai-app-chat-conv-del"
                onClick={() => void removeConversation(c.id)}
                title="删除对话"
                aria-label="删除对话"
                data-name={`ai-app-provider.chat-conv-item-${idx + 1}-delete-button`}
              >
                ×
              </IconButton>
            </div>
          ))}
        </div>
      </aside>

      {/* 右侧：消息区 + 输入框 */}
      <section className="ai-app-chat-main" data-name="ai-app-provider.chat-main">
        <div className="ai-app-chat-messages" data-name="ai-app-provider.chat-messages">
          {messages.length === 0 && !streaming && (
            <div className="ai-app-chat-placeholder" data-name="ai-app-provider.chat-placeholder">
              {currentProvider ? `开始与 ${currentProvider.name} 对话` : '请先在「自定义供应商」页配置供应商'}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
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
            />
          )}
          {streamError && (
            <div className="ai-app-chat-error" data-name="ai-app-provider.chat-error">{streamError}</div>
          )}
          <div ref={messagesEndRef} data-name="ai-app-provider.chat-messages-end" />
        </div>
        {/* 需求 10：记录文本模板折叠面板 */}
        <div className="ai-app-chat-record-template" data-name="ai-app-provider.chat-record-template-panel">
          <button
            type="button"
            className="ai-app-chat-record-template-toggle"
            data-name="ai-app-provider.chat-record-template-toggle-button"
            onClick={() => setShowRecordTemplate((v) => !v)}
          >
            {showRecordTemplate ? '▾' : '▸'} 记录文本模板
          </button>
          {showRecordTemplate && (
            <div className="ai-app-chat-record-template-body" data-name="ai-app-provider.chat-record-template-body">
              <div className="ai-app-chat-record-template-row" data-name="ai-app-provider.chat-record-template-prefix-row">
                <label className="ai-app-chat-record-template-label" data-name="ai-app-provider.chat-record-template-prefix-label">前缀</label>
                <input
                  type="text"
                  className="ai-app-chat-record-template-input"
                  data-name="ai-app-provider.chat-record-template-prefix-input"
                  placeholder="例如：[{{time}}] "
                  value={recordTextPrefix}
                  onChange={(e) => setRecordTextPrefix(e.target.value)}
                  onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                />
              </div>
              <div className="ai-app-chat-record-template-row" data-name="ai-app-provider.chat-record-template-suffix-row">
                <label className="ai-app-chat-record-template-label" data-name="ai-app-provider.chat-record-template-suffix-label">后缀</label>
                <input
                  type="text"
                  className="ai-app-chat-record-template-input"
                  data-name="ai-app-provider.chat-record-template-suffix-input"
                  placeholder="例如：——{{tag}}"
                  value={recordTextSuffix}
                  onChange={(e) => setRecordTextSuffix(e.target.value)}
                  onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                />
              </div>
              <div className="ai-app-chat-record-template-hint" data-name="ai-app-provider.chat-record-template-hint">
                占位符：<code>{'{{time}}'}</code> 当前时间；<code>{'{{tag}}'}</code> 供应商名。仅影响保存的 AI 回复，不改变实时显示。
              </div>
            </div>
          )}
        </div>
        <div className="ai-app-chat-input-wrap" data-name="ai-app-provider.chat-input-wrap">
          <textarea
            ref={inputRef}
            className="ai-app-chat-input"
            value={input}
            placeholder={currentProvider ? `发送给 ${currentProvider.name}...` : '请先选择供应商'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!currentProviderId}
            data-name="ai-app-provider.chat-input-textarea"
          />
          <div className="ai-app-chat-input-actions" data-name="ai-app-provider.chat-input-actions">
            {streaming ? (
              <button type="button" className="btn-primary-flat ai-app-chat-send cancel" onClick={() => void cancelStream()} data-name="ai-app-provider.chat-stop-button">停止</button>
            ) : (
              <button
                type="button"
                className="btn-primary-flat ai-app-chat-send"
                onClick={() => void handleSend()}
                disabled={!input.trim() || !currentProviderId}
                data-name="ai-app-provider.chat-send-button"
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
