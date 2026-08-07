// 维护性说明：本文件超过 300 行建议上限。
// 拆分计划：按标签页拆分 ConversationsPanel/LoginTracesPanel/WindowTracesPanel 子组件。
// 暂缓原因：搜索、列表、详情、导入导出状态共享且交互复杂，
// 拆分需梳理跨面板状态流转，避免破坏历史搜索与导入导出功能。
/* =====================================================================
   pages/HistoryView.tsx —— 历史搜索独立窗口
   架构：
   - 顶栏：标题 + 搜索框 + 最小化/最大化/关闭
   - 左侧：分类标签（对话 / 登录痕迹 / 窗口操作）+ 对话列表
   - 右侧：选中对话的消息详情 / 痕迹列表
   - 数据来源：SQLite（webview 抓取 + API 直连 + 登录/窗口痕迹）
   - 全文搜索：复用 chat.search IPC（FTS5）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { Button, SegmentedControl } from '../components/ui';
import Popover from '../components/ui/Popover';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import {
  listConversations,
  listMessages,
  deleteConversation,
  searchMessages,
  listLoginTraces,
  listWindowTraces,
  exportConversation,
  importConversation,
  clearConversations,
  clearLoginTraces,
  clearWindowTraces,
  updateMessage,
  deleteMessage,
  updateConversation,
  getUsageStats,
  onConversationPersisted,
} from '../lib/electron-api';
import type { Conversation, ChatMessage, LoginTrace, WindowTrace } from '../lib/electron-api';
import { formatTime } from '../lib/datetime';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import './HistoryView.css';

/** 来源类型中文标签 */
function sourceTypeLabel(t: string): string {
  switch (t) {
    case 'webview':
      return '网页抓取';
    case 'api':
      return 'API 直连';
    default:
      return t;
  }
}

type Tab = 'conversations' | 'logins' | 'windows';

export default function HistoryView() {
  const [tab, setTab] = useState<Tab>('conversations');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loginTraces, setLoginTraces] = useState<LoginTrace[]>([]);
  const [windowTraces, setWindowTraces] = useState<WindowTrace[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<ChatMessage & { conversationTitle: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingMsgContent, setEditingMsgContent] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [usageStats, setUsageStats] = useState<{ totalTokens: number; todayTokens: number; todayCount: number } | null>(null);
  const importMenuRef = useRef<HTMLButtonElement | null>(null);

  // ESC / Ctrl+W 关窗：导入菜单展开时 ESC 优先收起菜单，否则关闭窗口
  // 注：消息/标题编辑态的 ESC 由各自 input/textarea 自行处理；hook 默认跳过输入框聚焦
  useEscToCloseWindow({
    onEsc: () => {
      if (showImportMenu) {
        setShowImportMenu(false);
        return true;
      }
      return false;
    },
  });

  // 初始化：加载对话列表 + 登录/窗口痕迹
  useEffect(() => {
    void refreshConversations();
    void listLoginTraces().then(setLoginTraces).catch((e) => console.error('[HistoryView] 加载登录痕迹失败:', e));
    void listWindowTraces().then(setWindowTraces).catch((e) => console.error('[HistoryView] 加载窗口痕迹失败:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 刷新对话列表
  const refreshConversations = useCallback(async () => {
    setIsLoadingList(true);
    try {
      const list = await listConversations();
      setConversations(list);
    } catch (e) {
      console.error('[HistoryView] 加载对话列表失败:', e);
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  // 订阅 webview 抓取入库广播：其他窗口（WebviewTab）入库后实时刷新侧边栏
  // 防抖 500ms：persistPairs 可能在一轮 tick 内多次调用（多条消息），合并为一次刷新
  const persistedRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsubscribe = onConversationPersisted((payload) => {
      console.log('[HistoryView] 收到入库广播, sourceId=', payload.sourceId);
      if (persistedRefreshTimerRef.current) {
        clearTimeout(persistedRefreshTimerRef.current);
      }
      persistedRefreshTimerRef.current = setTimeout(() => {
        console.log('[HistoryView] 防抖触发, 开始刷新对话列表');
        void refreshConversations();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (persistedRefreshTimerRef.current) {
        clearTimeout(persistedRefreshTimerRef.current);
      }
    };
  }, [refreshConversations]);

  // 选中对话时加载消息
  useEffect(() => {
    if (!selectedConvId) {
      setMessages([]);
      return;
    }
    void listMessages(selectedConvId)
      .then(setMessages)
      .catch((e) => console.error('[HistoryView] 加载消息失败:', e));
  }, [selectedConvId]);

  const debouncedSearch = useDebouncedCallback((q: string) => {
    if (!q) return;
    void searchMessages(q)
      .then((results) => setSearchResults(results))
      .catch((e) => {
        console.error('[HistoryView] 搜索失败:', e);
        setSearchResults([]);
      })
      .finally(() => setSearching(false));
  }, 300);

  // 搜索防抖（300ms）
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      setSearching(false);
    } else {
      setSearching(true);
    }
    // 始终调用以清除旧定时器（空查询时 fn 内部直接返回，不触发搜索）
    debouncedSearch(q);
  }, [searchQuery, debouncedSearch]);

  const handleDeleteConv = async (id: string) => {
    if (!confirm('确定删除该对话？删除后无法恢复。')) return;
    try {
      await deleteConversation(id);
      if (selectedConvId === id) {
        setSelectedConvId(null);
        setMessages([]);
      }
      void refreshConversations();
    } catch (e) {
      console.error('[HistoryView] 删除对话失败:', e);
      alert('删除失败');
    }
  };

  const handleExport = async (id: string, format: 'md' | 'json') => {
    try {
      const r = await exportConversation(id, format);
      if (r.ok && r.filePath) {
      } else if (!r.canceled) {
        alert('导出失败');
      }
    } catch (e) {
      console.error('[HistoryView] 导出失败:', e);
      alert('导出失败');
    }
  };

  const handleImport = async (format: 'json' | 'deepseek' | 'md') => {
    setShowImportMenu(false);
    try {
      // 使用一个默认的 sourceId（"imported"）
      const r = await importConversation(format, 'imported');
      if (r.ok && r.conversation) {
        void refreshConversations();
        setSelectedConvId(r.conversation.id);
      }
    } catch (e) {
      console.error('[HistoryView] 导入失败:', e);
      alert('导入失败：' + (e as Error).message);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('确定要清空所有对话记录吗？此操作不可恢复！')) return;
    if (!confirm('再次确认：所有对话将被永久删除，确定继续？')) return;
    try {
      const r = await clearConversations();
      alert(`已清空 ${r.count} 条对话`);
      setSelectedConvId(null);
      setMessages([]);
      void refreshConversations();
    } catch (e) {
      console.error('[HistoryView] 清空失败:', e);
      alert('清空失败');
    }
  };

  const handleClearLogins = async () => {
    if (!confirm('确定要清空所有登录痕迹吗？此操作不可恢复！')) return;
    try {
      const r = await clearLoginTraces();
      alert(`已清空 ${r.count} 条登录痕迹`);
      setLoginTraces([]);
    } catch (e) {
      console.error('[HistoryView] 清空登录痕迹失败:', e);
      alert('清空失败');
    }
  };

  const handleClearWindows = async () => {
    if (!confirm('确定要清空所有窗口操作痕迹吗？此操作不可恢复！')) return;
    try {
      const r = await clearWindowTraces();
      alert(`已清空 ${r.count} 条窗口操作痕迹`);
      setWindowTraces([]);
    } catch (e) {
      console.error('[HistoryView] 清空窗口痕迹失败:', e);
      alert('清空失败');
    }
  };

  const handleStartEditMsg = (msg: ChatMessage) => {
    setEditingMsgId(msg.id);
    setEditingMsgContent(msg.content);
  };

  const handleSaveEditMsg = async () => {
    if (!editingMsgId) return;
    try {
      await updateMessage(editingMsgId, { content: editingMsgContent });
      setEditingMsgId(null);
      setEditingMsgContent('');
      if (selectedConvId) {
        void listMessages(selectedConvId).then(setMessages);
      }
      void refreshConversations();
    } catch (e) {
      console.error('[HistoryView] 更新消息失败:', e);
      alert('更新失败');
    }
  };

  const handleCancelEditMsg = () => {
    setEditingMsgId(null);
    setEditingMsgContent('');
  };

  const handleDeleteMsg = async (msgId: string) => {
    if (!confirm('确定删除这条消息？')) return;
    try {
      await deleteMessage(msgId);
      if (selectedConvId) {
        void listMessages(selectedConvId).then(setMessages);
      }
      void refreshConversations();
    } catch (e) {
      console.error('[HistoryView] 删除消息失败:', e);
      alert('删除失败');
    }
  };

  const handleStartEditTitle = () => {
    if (!selectedConv) return;
    setEditTitleValue(selectedConv.title || '');
    setEditingTitle(true);
  };

  const handleSaveTitle = async () => {
    if (!selectedConvId) return;
    try {
      await updateConversation(selectedConvId, { title: editTitleValue });
      setEditingTitle(false);
      void refreshConversations();
    } catch (e) {
      console.error('[HistoryView] 更新标题失败:', e);
      alert('更新失败');
    }
  };

  const handleCancelEditTitle = () => {
    setEditingTitle(false);
    setEditTitleValue('');
  };

  // I2：导入菜单的点击外部关闭由 Popover 组件的 closeOnOutsideClick 处理，无需自定义监听

  const selectedConv = useMemo(
    () => conversations.find((c) => c.id === selectedConvId) ?? null,
    [conversations, selectedConvId],
  );

  // 选中对话时加载 token 用量统计（按当前对话的 sourceId 过滤）
  useEffect(() => {
    if (!selectedConv) {
      setUsageStats(null);
      return;
    }
    void getUsageStats(selectedConv.sourceId)
      .then(setUsageStats)
      .catch((e) => console.error('[HistoryView] 加载用量统计失败:', e));
  }, [selectedConv]);

  // 展示层全局去重：同 role + 同 content 的消息仅保留首条，dupCount 标注总重复次数。
  // 存储层已用 content_hash + INSERT OR IGNORE 防止重复入库；此处仅做视觉合并，
  // 保留首条并标注重复次数，重复条目折叠不渲染正文。
  const mergedMessages = useMemo(() => {
    const result: Array<{ msg: ChatMessage; dupCount: number }> = [];
    const seen = new Map<string, number>(); // key(role\0content) → result 索引
    for (const m of messages) {
      const key = `${m.role}\u0000${m.content}`;
      const idx = seen.get(key);
      if (idx !== undefined) {
        result[idx].dupCount += 1;
      } else {
        seen.set(key, result.length);
        result.push({ msg: m, dupCount: 0 });
      }
    }
    return result;
  }, [messages]);

  const isSearching = searchQuery.trim().length > 0;

  return (
    <>
      <WindowResizeHandles />
      <div className="history-view app-shell app-view-root" data-name="history.container">
        {/* 顶栏：统一 StandaloneWindowHeader（标题 + 搜索框 + 置顶 + 窗口控制） */}
        <StandaloneWindowHeader
          title="历史搜索"
          dataNamePrefix="history.top-bar"
          center={
            <>
              <span className="history-top-title" data-name="history.top-bar.title">历史搜索</span>
              <div className="history-search-wrap" data-name="history.top-bar.search-wrap">
                <input
                  type="text"
                  className="history-search-input"
                  data-name="history.top-bar.search-input"
                  placeholder="搜索所有对话内容…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                />
              </div>
            </>
          }
        />

        {/* 主体 */}
        <div className="history-body" data-name="history.body">
          {/* 左侧栏 */}
          <div className="history-sidebar" data-name="history.sidebar.container">
            <div className="history-tabs" data-name="history.sidebar.tabs">
              <SegmentedControl<Tab>
                value={tab}
                onChange={setTab}
                data-name="history.sidebar.tabs-segmented-control"
                name="history-tab"
                options={[
                  { value: 'conversations', label: `对话 (${conversations.length})` },
                  { value: 'logins', label: `登录 (${loginTraces.length})` },
                  { value: 'windows', label: `窗口 (${windowTraces.length})` },
                ]}
              />
            </div>

            <div className="history-list" data-name="history.sidebar.list">
              {tab === 'conversations' && (
                <>
                  <div className="conv-toolbar" data-name="history.sidebar.conv-toolbar">
                    <Button
                      variant="outline"
                      type="button"
                      ref={importMenuRef}
                      data-name="history.sidebar.import-button"
                      onClick={() => setShowImportMenu((v) => !v)}
                    >
                      导入
                    </Button>
                    <Popover
                      isOpen={showImportMenu}
                      onClose={() => setShowImportMenu(false)}
                      triggerRef={importMenuRef}
                      variant="dropdown"
                      config={{ closeOnOutsideClick: true, closeOnEsc: true }}
                      style={{ minWidth: 160 }}
                      dataName="history.sidebar.import-menu"
                    >
                      <button
                        type="button"
                        className="history-import-menu-item"
                        data-name="history.sidebar.import-menu-item-1"
                        onClick={() => { setShowImportMenu(false); void handleImport('json'); }}
                      >
                        本地格式 (JSON)
                      </button>
                      <button
                        type="button"
                        className="history-import-menu-item"
                        data-name="history.sidebar.import-menu-item-2"
                        onClick={() => { setShowImportMenu(false); void handleImport('deepseek'); }}
                      >
                        DeepSeek 导出
                      </button>
                      <button
                        type="button"
                        className="history-import-menu-item"
                        data-name="history.sidebar.import-menu-item-3"
                        onClick={() => { setShowImportMenu(false); void handleImport('md'); }}
                      >
                        Markdown
                      </button>
                    </Popover>
                    <Button
                      variant="danger"
                      type="button"
                      data-name="history.sidebar.clear-all-button"
                      onClick={() => void handleClearAll()}
                    >
                      清空所有
                    </Button>
                  </div>
                  {isLoadingList && conversations.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.sidebar.list-loading">加载中…</div>
                  )}
                  {!isLoadingList && conversations.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.sidebar.list-empty">暂无对话数据<br />浏览 AI 平台或使用自定义窗口后，对话将自动保存到本地</div>
                  )}
                  {conversations.map((c, idx) => (
                    <div
                      key={c.id}
                      data-name={`history.sidebar.conv-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={c.id}
                      className={`glass-card interactive conv-item${selectedConvId === c.id ? ' active' : ''}`}
                      onClick={() => setSelectedConvId(c.id)}
                    >
                      <div className="conv-item-head" data-name="history.sidebar.conv-item-head">
                        <span className="conv-item-title" data-name="history.sidebar.conv-item-title">{c.title || '未命名对话'}</span>
                        <span className={`conv-item-badge ${c.sourceType}`} data-name="history.sidebar.conv-item-badge">{sourceTypeLabel(c.sourceType)}</span>
                      </div>
                      <div className="conv-item-meta" data-name="history.sidebar.conv-item-meta">
                        <span data-name="history.sidebar.conv-item-time">{formatTime(c.updatedAt, 'datetime')}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}

              {tab === 'logins' && (
                <>
                  <div className="conv-toolbar" data-name="history.sidebar.logins-toolbar">
                    <Button
                      variant="danger"
                      type="button"
                      data-name="history.sidebar.clear-logins-button"
                      onClick={() => void handleClearLogins()}
                      disabled={loginTraces.length === 0}
                    >
                      清空所有
                    </Button>
                  </div>
                  {loginTraces.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.sidebar.logins-empty">暂无登录痕迹</div>
                  )}
                  {loginTraces.map((t, idx) => (
                    <div key={t.id} className="glass-card trace-item" data-name={`history.sidebar.login-trace-item-${idx + 1}`} data-index={idx + 1} data-id={t.id}>
                      <div className="trace-item-head" data-name="history.sidebar.login-trace-head">
                        <span className="trace-item-title" data-name="history.sidebar.login-trace-title">{t.platform || t.profileId}</span>
                        <span className="trace-item-time" data-name="history.sidebar.login-trace-time">{formatTime(t.loginTime, 'datetime')}</span>
                      </div>
                      {t.loginUrl && <div className="trace-item-detail" data-name="history.sidebar.login-trace-detail">{t.loginUrl}</div>}
                    </div>
                  ))}
                </>
              )}

              {tab === 'windows' && (
                <>
                  <div className="conv-toolbar" data-name="history.sidebar.windows-toolbar">
                    <Button
                      variant="danger"
                      type="button"
                      data-name="history.sidebar.clear-windows-button"
                      onClick={() => void handleClearWindows()}
                      disabled={windowTraces.length === 0}
                    >
                      清空所有
                    </Button>
                  </div>
                  {windowTraces.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.sidebar.windows-empty">暂无窗口操作痕迹</div>
                  )}
                  {windowTraces.map((t, idx) => (
                    <div key={t.id} className="glass-card trace-item" data-name={`history.sidebar.window-trace-item-${idx + 1}`} data-index={idx + 1} data-id={t.id}>
                      <div className="trace-item-head" data-name="history.sidebar.window-trace-head">
                        <span className="trace-item-title" data-name="history.sidebar.window-trace-title">{t.action} · {t.windowId}</span>
                        <span className="trace-item-time" data-name="history.sidebar.window-trace-time">{formatTime(t.timestamp, 'datetime')}</span>
                      </div>
                      {t.detail && <div className="trace-item-detail" data-name="history.sidebar.window-trace-detail">{t.detail}</div>}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* 右侧详情 */}
          <div className="history-detail" data-name="history.detail.container">
            {isSearching ? (
              <>
                <div className="history-detail-head" data-name="history.detail.search-head">
                  <span className="history-detail-title" data-name="history.detail.search-title">搜索结果 ({searchResults.length})</span>
                </div>
                <div className="history-search-results" data-name="history.detail.search-results">
                  {searching && <div className="history-list-empty app-empty-state large" data-name="history.detail.searching-indicator">搜索中…</div>}
                  {!searching && searchResults.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.detail.search-no-results">未找到匹配内容</div>
                  )}
                  {searchResults.map((m, idx) => (
                    <div
                      key={m.id}
                      className="search-result-item"
                      data-name={`history.detail.search-result-item-${idx + 1}`}
                      data-index={idx + 1}
                      data-id={m.id}
                      onClick={() => {
                        // 跳转到对应对话
                        setTab('conversations');
                        setSearchQuery('');
                        setSelectedConvId(m.conversationId);
                      }}
                    >
                      <div className="search-result-conv" data-name="history.detail.search-result-conv">{m.conversationTitle}</div>
                      <div className="search-result-content" data-name="history.detail.search-result-content">{m.content}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : tab === 'conversations' && selectedConv ? (
              <>
                <div className="history-detail-head" data-name="history.detail.head">
                  {editingTitle ? (
                    <>
                      <input
                        type="text"
                        className="conv-title-input"
                        data-name="history.detail.title-input"
                        value={editTitleValue}
                        onChange={(e) => setEditTitleValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSaveTitle();
                          if (e.key === 'Escape') handleCancelEditTitle();
                        }}
                        autoFocus
                      />
                      <div className="history-detail-actions" data-name="history.detail.edit-title-actions">
                        <Button type="button" variant="outline" className="history-detail-btn" onClick={handleCancelEditTitle}>
                          取消
                        </Button>
                        <Button type="button" variant="outline" className="history-detail-btn" onClick={() => void handleSaveTitle()}>
                          保存
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span
                        className="history-detail-title"
                        data-name="history.detail.title"
                        onClick={handleStartEditTitle}
                        title="点击编辑标题"
                        style={{ cursor: 'pointer' }}
                      >
                        {selectedConv.title || '未命名对话'}
                      </span>
                      {usageStats && usageStats.totalTokens > 0 && (
                        <span
                          data-name="history.detail.usage-stats"
                          style={{
                            flex: 'none',
                            fontFamily: 'var(--font-sans)',
                            fontSize: 'var(--text-xs)',
                            fontWeight: 600,
                            color: 'var(--accent-bright)',
                            background: 'var(--accent-10)',
                            border: '1px solid var(--accent-25)',
                            borderRadius: 'var(--radius-xs)',
                            padding: 'var(--space-0-5) var(--space-1-5)',
                            whiteSpace: 'nowrap',
                            letterSpacing: '0.02em',
                          }}
                          title={`今日 ${usageStats.todayTokens} tokens / 今日 ${usageStats.todayCount} 次 / 共 ${usageStats.totalTokens} tokens`}
                        >
                          今日 {usageStats.todayTokens} tok · {usageStats.todayCount} 次 / 共 {usageStats.totalTokens} tok
                        </span>
                      )}
                      <div className="history-detail-actions" data-name="history.detail.actions">
                        <Button type="button" variant="outline" className="history-detail-btn" onClick={() => void handleExport(selectedConv.id, 'md')}>
                          导出 MD
                        </Button>
                        <Button type="button" variant="outline" className="history-detail-btn" onClick={() => void handleExport(selectedConv.id, 'json')}>
                          导出 JSON
                        </Button>
                        <Button type="button" variant="text" danger className="history-detail-btn danger" onClick={() => void handleDeleteConv(selectedConv.id)}>
                          删除
                        </Button>
                      </div>
                    </>
                  )}
                </div>
                <div className="history-messages" data-name="history.detail.messages">
                  {messages.length === 0 && (
                    <div className="history-list-empty app-empty-state large" data-name="history.detail.messages-empty">该对话暂无消息</div>
                  )}
                  {mergedMessages.map(({ msg: m, dupCount }, idx) => (
                    <div key={m.id} className={`history-msg ${m.role}`} data-name={`history.detail.msg-item-${idx + 1}`} data-index={idx + 1} data-id={m.id}>
                      <div className="history-msg-role" data-name="history.detail.msg-role">
                        {m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}
                        {m.autoGrabbed && (
                          <span className="history-msg-auto-badge" data-name="history.detail.msg-auto-badge">自动抓取</span>
                        )}
                        {dupCount > 0 && <span className="history-msg-dup-badge" data-name="history.detail.msg-dup-badge">重复 ×{dupCount + 1}</span>}
                      </div>
                      {editingMsgId === m.id ? (
                        <>
                          <textarea
                            className="msg-edit-textarea"
                            data-name="history.detail.msg-edit-textarea"
                            value={editingMsgContent}
                            onChange={(e) => setEditingMsgContent(e.target.value)}
                            autoFocus
                          />
                          <div className="msg-edit-actions" data-name="history.detail.msg-edit-actions">
                            <Button type="button" variant="outline" className="msg-edit-btn" onClick={handleCancelEditMsg}>
                              取消
                            </Button>
                            <Button type="button" variant="primary-compact" className="msg-edit-btn primary" onClick={() => void handleSaveEditMsg()}>
                              保存
                            </Button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="history-msg-content" data-name="history.detail.msg-content">{m.content}</div>
                          {m.tokens != null && (
                            <div className="history-msg-meta" data-name="history.detail.msg-meta">tokens: {m.tokens} · {formatTime(m.createdAt, 'datetime')}</div>
                          )}
                          <div className="msg-actions" data-name="history.detail.msg-actions">
                            <Button type="button" variant="outline" className="msg-action-btn" onClick={() => handleStartEditMsg(m)}>
                              编辑
                            </Button>
                            <Button type="button" variant="text" danger className="msg-action-btn danger" onClick={() => void handleDeleteMsg(m.id)}>
                              删除
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="history-messages" data-name="history.detail.empty-messages">
                <div className="history-list-empty app-empty-state large" data-name="history.detail.empty-placeholder">
                  {tab === 'conversations' ? '选择左侧对话查看详情' : tab === 'logins' ? '登录痕迹记录各 AI 平台的登录时间与 URL' : '窗口操作痕迹记录窗口的创建/关闭/最大化等行为'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
