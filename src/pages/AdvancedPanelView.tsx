/* =====================================================================
   pages/AdvancedPanelView.tsx —— 进阶面板主视图
   架构：
   - 顶栏：tab 切换（自定义供应商 / 自定义对话）+ 窗口控制（最小化/最大化/关闭）
   - 主体：根据 activeTab 渲染两个子页面
     · providers  —— 自定义供应商管理（添加/编辑/删除/测试，复用 useChatStore 的 provider 管理）
     · chat       —— 自定义对话（复用 useChatStore 的会话/流式；左侧会话列表 + 右侧消息区）
   - 通过 URL 查询参数 ?mode=advanced-panel[&provider=...&tab=...] 接收初始状态
   - 主进程通过 'advancedPanel:navigate' 事件通知切换 tab/provider（单例窗口复用时）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { useChatStore } from '../store/useChatStore';
import {
  minimizeWindow,
  closeCurrentWindow,
  onAdvancedPanelNavigate,
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
  getAppSettings,
  updateAppSettings,
} from '../lib/electron-api';
import type {
  CustomAIProvider,
  CustomAIProviderInput,
} from '../lib/electron-api';
import Badge from '../components/ui/Badge';
import { Button, IconButton, SegmentedControl, TitleBar, Combobox } from '../components/ui';
import type { ComboboxOption } from '../components/ui';
import AdvancedPanelSettingsPanel from '../components/AdvancedPanelSettingsPanel';
import SidebarResizer from '../components/SidebarResizer';
import { MessageBubble } from './MessageBubble';
import WhiteboardView from './WhiteboardView';
import NotesView from './NotesView';
import { useWindowMaximizedAndPinned } from '../hooks/useWindowMaximizedAndPinned';
import { isTypingTarget } from '../lib/shared-utils';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import { useUiVersionStore } from '../store/useUiVersionStore';
import { resolveParam, setManualOverride, isManual } from '../lib/oxy-override-store';
import { OXY_PANELS } from '../lib/oxy-config';
import './AdvancedPanelView.css';

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

export default function AdvancedPanelView() {
  const [activeTab, setActiveTab] = useState<TabKey>(readInitialTab);
  const { isMaximized, isPinned, setIsMaximized, setIsPinned, handleMaximize } = useWindowMaximizedAndPinned();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialProviderId = useMemo(() => readInitialProviderId(), []);

  // 白板应用层侧边栏显隐（默认 false；Excalidraw 无内置多页面 UI，sidebar 是多白板管理入口）
  // 设置面板关闭时重新读取，使设置变更立即生效
  const [whiteboardSidebarVisible, setWhiteboardSidebarVisible] = useState(false);
  useEffect(() => {
    void getAppSettings()
      .then((cfg) => setWhiteboardSidebarVisible(cfg.whiteboardSidebarVisible ?? false))
      .catch(() => {});
  }, []);

  // 监听主进程的 navigate 事件（单例窗口复用时切换 tab/provider）
  useEffect(() => {
    return onAdvancedPanelNavigate((payload) => {
      setActiveTab(payload.tab);
      if (payload.providerId) {
        useChatStore.getState().setCurrentProvider(payload.providerId);
      }
    });
  }, []);

  // Ctrl+1/2/3 快捷键切换进阶面板标签（对话/白板/笔记）
  // 在输入框内不触发（避免影响输入）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      const tabMap: Record<string, TabKey> = {
        '1': 'chat',
        '2': 'whiteboard',
        '3': 'notes',
      };
      const next = tabMap[e.key];
      if (next) {
        e.preventDefault();
        setActiveTab(next);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
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

  // ESC / Ctrl+W 关窗：进阶面板无标题编辑态，onEsc 直接关闭窗口
  useEscToCloseWindow();

  const handleMinimize = useCallback(() => void minimizeWindow().catch(() => {}), []);
  // handleMaximize 由 useWindowMaximizedAndPinned 统一提供
  const handleClose = useCallback(() => void closeCurrentWindow().catch(() => {}), []);

  return (
    <div className="advanced-panel-provider-view app-shell app-view-root" data-name="advanced-panel.container">
      <TitleBar
        maximized={isMaximized}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
        center={
          <SegmentedControl<TabKey>
            value={activeTab}
            onChange={setActiveTab}
            name="advanced-panel-tab"
            className="advanced-panel-segmented"
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
              data-name="advanced-panel.topbar-settings-button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="advanced-panel.topbar-settings-icon">
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
              data-name="advanced-panel.topbar-pin-button"
            >
              <svg viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="advanced-panel.topbar-pin-icon">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </IconButton>
          </>
        }
      />
      <div className="advanced-panel-provider-body" data-name="advanced-panel.body">
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'whiteboard' && (
          <WhiteboardView
            onClose={() => setActiveTab('chat')}
            sidebarVisible={whiteboardSidebarVisible}
          />
        )}
        {activeTab === 'notes' && <NotesView />}
      </div>
      <AdvancedPanelSettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          // 设置面板关闭时重新读取白板侧边栏设置，使开关变化立即生效
          void getAppSettings()
            .then((cfg) => setWhiteboardSidebarVisible(cfg.whiteboardSidebarVisible ?? false))
            .catch(() => {});
        }}
      />
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
    editProvider,
    selectConversation,
    startNewConversation,
    removeConversation,
    sendMessage,
    cancelStream,
    registerStreamListeners,
  } = useChatStore();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 侧边栏宽度/收起状态
  const isOxy = useUiVersionStore((s) => s.version === 'oxy');
  const OXY_SIDEBAR_KEY = 'chatSidebar.width';

  // Oxy auto 宽度计算
  const computeAutoSidebarWidth = useCallback(() => {
    if (typeof window === 'undefined') return 160;
    const parentW = window.innerWidth;
    return Math.max(
      OXY_PANELS.sidebar.widthMin,
      Math.min(OXY_PANELS.sidebar.widthMax, Math.round(parentW * OXY_PANELS.sidebar.parentRatio)),
    );
  }, []);

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (isOxy) {
      return resolveParam(OXY_SIDEBAR_KEY, computeAutoSidebarWidth());
    }
    return 160;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // 初始化 providers + 流式监听
  useEffect(() => {
    void initProviders();
    const off = registerStreamListeners();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 读取侧边栏宽度/收起设置
  useEffect(() => {
    if (isOxy) {
      // Oxy 模式：auto 或 manual override
      if (isManual(OXY_SIDEBAR_KEY)) {
        setSidebarWidth(resolveParam(OXY_SIDEBAR_KEY, computeAutoSidebarWidth()));
      } else {
        setSidebarWidth(computeAutoSidebarWidth());
      }
    } else {
      void getAppSettings()
        .then((cfg) => {
          setSidebarWidth(cfg.chatSidebarWidth ?? 160);
          setSidebarCollapsed(cfg.chatSidebarCollapsed ?? false);
        })
        .catch(() => {});
    }
  }, [isOxy, computeAutoSidebarWidth, OXY_SIDEBAR_KEY]);

  // Oxy 模式下窗口 resize 时 auto 宽度跟随
  useEffect(() => {
    if (!isOxy || isManual(OXY_SIDEBAR_KEY)) return;
    const handler = () => setSidebarWidth(computeAutoSidebarWidth());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [isOxy, computeAutoSidebarWidth, OXY_SIDEBAR_KEY]);

  // 侧边栏拖拽调宽：即时更新状态，松开时持久化
  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w);
    if (isOxy) {
      setManualOverride(OXY_SIDEBAR_KEY, w);
    } else {
      void updateAppSettings({ chatSidebarWidth: w });
    }
  }, [isOxy, OXY_SIDEBAR_KEY]);

  // 侧边栏收起/展开切换
  const handleSidebarToggleCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    void updateAppSettings({ chatSidebarCollapsed: next });
  }, [sidebarCollapsed]);

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

  return (
    <div className="advanced-panel-chat" data-name="advanced-panel.chat">
      {/* 左侧：provider 选择 + 会话列表 */}
      <aside
        className={`advanced-panel-chat-sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`}
        style={sidebarCollapsed ? undefined : { width: `${sidebarWidth}px`, flex: 'none' }}
        data-name="advanced-panel.chat-sidebar"
      >
        {sidebarCollapsed && (
          <button className="advanced-panel-chat-sidebar-expand-btn" onClick={handleSidebarToggleCollapse} title="展开侧边栏" data-name="advanced-panel.chat-sidebar-expand-button">
            »
          </button>
        )}
        <div className="advanced-panel-chat-provider" data-name="advanced-panel.chat-provider">
          <label className="advanced-panel-chat-provider-label" data-name="advanced-panel.chat-provider-label">当前模型</label>
          <div className="advanced-panel-chat-provider-selector" data-name="advanced-panel.chat-provider-selector">
            <Combobox
              inputValue={(() => {
                if (providers.length === 0) return '未配置供应商';
                const cur = providers.find((p) => p.id === currentProviderId);
                return cur ? cur.model : '';
              })()}
              onInputChange={() => {}}
              inputPlaceholder="选择模型"
              inputClassName="advanced-panel-chat-provider-select"
              inputReadOnly
              disabled={providers.length === 0}
              options={providers.flatMap<ComboboxOption>((p) => {
                const models = [p.model, ...(p.alternativeModels ?? [])];
                return models.map((m) => ({
                  value: `${p.id}::${m}`,
                  label: m,
                  selected: p.id === currentProviderId && p.model === m,
                }));
              })}
              onSelect={async (v) => {
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
              }}
              searchable
              searchPlaceholder="搜索模型…"
              emptyText="无匹配模型"
              dataName="advanced-panel.chat-provider-select"
            />
          </div>
        </div>
        <Button type="button" variant="outline" className="advanced-panel-chat-new" onClick={startNewConversation} data-name="advanced-panel.chat-new-conversation-button">+ 新建对话</Button>
        <IconButton variant="default" className="advanced-panel-chat-sidebar-collapse" aria-label="收起侧边栏" onClick={handleSidebarToggleCollapse} title="收起侧边栏" data-name="advanced-panel.chat-sidebar-collapse-button">
          «
        </IconButton>
        <div className="advanced-panel-chat-conv-list" data-name="advanced-panel.chat-conv-list">
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
        {!sidebarCollapsed && <SidebarResizer width={sidebarWidth} minWidth={120} maxWidth={400} onResize={handleSidebarResize} />}
      </aside>

      {/* 右侧：消息区 + 输入框 */}
      <section className="advanced-panel-chat-main" data-name="advanced-panel.chat-main">
        <div className="advanced-panel-chat-messages" data-name="advanced-panel.chat-messages">
          {messages.length === 0 && !streaming && (
            <div className="advanced-panel-chat-placeholder" data-name="advanced-panel.chat-placeholder">
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
            <div className="advanced-panel-chat-error" data-name="advanced-panel.chat-error">{streamError}</div>
          )}
          <div ref={messagesEndRef} data-name="advanced-panel.chat-messages-end" />
        </div>
        <div className="advanced-panel-chat-input-wrap" data-name="advanced-panel.chat-input-wrap">
          <textarea
            ref={inputRef}
            className="advanced-panel-chat-input"
            value={input}
            placeholder={currentProvider ? `发送给 ${currentProvider.name}...` : '请先选择供应商'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!currentProviderId}
            data-name="advanced-panel.chat-input-textarea"
          />
          <div className="advanced-panel-chat-input-actions" data-name="advanced-panel.chat-input-actions">
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
