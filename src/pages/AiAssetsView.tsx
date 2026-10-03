import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Files, List, MessageSquare, RefreshCw, Search, SquareLibrary, Upload, X } from 'lucide-react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { Button, ConfirmDialog, EmptyState, IconButton } from '../components/ui';
import PromptLibraryView from './PromptLibraryView';
import AssetConversation from './ai-assets/AssetConversation';
import AssetFileCard from './ai-assets/AssetFileCard';
import AssetCollectionStatus from './ai-assets/AssetCollectionStatus';
import AssetSettingsPanel from '../components/AssetSettingsPanel';
import Modal from '../components/ui/Modal';
import { useAssetSettings } from '../hooks/useAssetSettings';
import { normalizeAssetAccelerator } from '../../electron/shared/asset-settings';
import { listConversations, importConversation, onConversationPersisted } from '../lib/electron-api';
import { requireElectron } from '../lib/electron-api/core';
import type { Conversation, PromptExample } from '../lib/electron-api';
import type { AssetAttachment, AssetPromptSuggestion, AssetTextUsage } from '../../electron/shared/ai-assets.types';
import { useEscToCloseWindow, hasOverlay } from '../hooks/useEscToCloseWindow';
import './AiAssetsView.css';
import { isAssetInterfaceImage } from '../../electron/shared/asset-presentation';
import { useAssetMenuDismissal } from './ai-assets/useAssetMenuDismissal';

type Category = 'conversations' | 'prompts' | 'files';
type ConversationTarget = { messageId?: string; attachmentId?: string };
const categories = [
  { id: 'conversations', label: '对话', Icon: MessageSquare },
  { id: 'prompts', label: '提示词', Icon: SquareLibrary },
  { id: 'files', label: '资料', Icon: Files },
] as const;

function conversationPlatform(conversation: Conversation) {
  if (conversation.sourceType === 'api') return 'API';
  try { return conversation.url ? new URL(conversation.url).hostname.replace(/^www\./, '') : '网页'; }
  catch { return '网页'; }
}

export default function AiAssetsView() {
  const rootRef = useRef<HTMLDivElement>(null);
  useAssetMenuDismissal(rootRef);
  const [totalUsage, setTotalUsage] = useState<AssetTextUsage>();
  const api = requireElectron().aiAssets;
  const promptApi = requireElectron().prompt;
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationRevision = useRef(-1);
  const sourceRevision = useRef(0);
  const importMenuRef = useRef<HTMLDetailsElement>(null);
  const [freezeTarget, setFreezeTarget] = useState<{ tabId: string; revision: number }>();
  const { settings, error: settingsError } = useAssetSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [views, setViews] = useState<Record<string, number>>({});
  const [branchRequest, setBranchRequest] = useState<{ direction: number; revision: number }>();
  const [category, setCategory] = useState<Category>('conversations');
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AssetAttachment[]>([]);
  const [fileDirection, setFileDirection] = useState<'all' | 'input' | 'output'>('input');
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingCleanup, setPendingCleanup] = useState<{ kind: 'files' | 'conversations'; ids: string[]; names: string[] }>();
  const [cleanupError, setCleanupError] = useState('');
  const cleaning = useRef(false);
  const [suggestions, setSuggestions] = useState<AssetPromptSuggestion[]>([]);
  const [matches, setMatches] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [promptDraft, setPromptDraft] = useState<{ revision: number; example: PromptExample; title?: string }>();
  const [conversationTarget, setConversationTarget] = useState<ConversationTarget & { revision: number }>();
  useEscToCloseWindow({ onEsc: () => {
    if (rootRef.current?.querySelector('.asset-selection-actions')) { window.getSelection()?.removeAllRanges(); return true; }
    if (selecting) { setSelecting(false); setSelectedIds([]); return true; }
    if (listOpen) { setListOpen(false); return true; }
    return false;
  } });

  useEffect(() => {
    const navigate = (request: import('../../electron/shared/ai-assets.types').AssetNavigationEvent) => {
      if (request.revision <= navigationRevision.current) return;
      navigationRevision.current = request.revision;
      if (request.category) { setCategory(request.category); setQuery(''); setListOpen(false); }
      if (request.focusSearch) searchRef.current?.focus();
      if (request.freezeTabId) { setFreezeTarget({ tabId: request.freezeTabId, revision: request.revision }); setSettingsOpen(true); }
      if (request.openSettings) setSettingsOpen(true);
    };
    const off = promptApi.onNavigate(navigate);
    void promptApi.navigation().then(navigate).catch(failure => setError(String(failure)));
    return off;
  }, [promptApi]);

  const refresh = useCallback(async () => {
    const [list, files, summaries, usage] = await Promise.all([listConversations(), api.attachments(), api.summaries(), api.usage()]);
    setViews(Object.fromEntries(summaries.map(item => [item.conversationId, item.views])));
    setTotalUsage(usage);
    setConversations(list); setAttachments(files);
    setSelected(current => current && list.some(item => item.id === current) ? current : list[0]?.id ?? null);
    setRevision(value => value + 1);
  }, [api]);
  useEffect(() => {
    if (category !== 'prompts') return;
    let active = true;
    void api.suggestions().then(items => { if (active) setSuggestions(items); }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [api, category, revision]);
  const run = async (operation: () => Promise<void>) => {
    setError(''); setNotice('');
    try { await operation(); } catch (failure) { setError(String(failure)); }
  };
  useEffect(() => {
    void refresh().catch(failure => setError(String(failure)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onConversationPersisted(() => {
      if (!timer) timer = setTimeout(() => { timer = undefined; void refresh().catch(failure => setError(String(failure))); }, 250);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void api.searchConversations(query).then(ids => { if (active) setMatches(ids); }).catch(failure => { if (active) setError(String(failure)); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [api, query, revision]);
  const visibleConversations = useMemo(() => conversations.filter(item => !query || matches.includes(item.id))
    .sort((a, b) => settings.sort === 'views' ? (views[b.id] ?? 0) - (views[a.id] ?? 0) || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt), [conversations, matches, query, settings.sort, views]);
  const visibleFiles = useMemo(() => attachments.filter(item => (fileDirection === 'all' || item.direction === fileDirection)
    && (!query || `${item.name} ${item.sourceUrl ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [attachments, query, fileDirection]);
  useEffect(() => { setSelectedIds([]); setSelecting(false); }, [category, query, fileDirection]);
  const selectionItems = useMemo(() => category === 'files' ? visibleFiles.map(item => ({ id: item.id, name: item.name }))
    : category === 'conversations' ? visibleConversations.map(item => ({ id: item.id, name: item.title || '未命名对话' })) : [], [category, visibleFiles, visibleConversations]);
  useEffect(() => { setSelectedIds(current => current.filter(id => selectionItems.some(item => item.id === id))); }, [selectionItems]);
  const toggleSelection = (id: string) => setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  useEffect(() => { setCleanupError(''); }, [pendingCleanup]);
  const clearSelection = async () => {
    if (!pendingCleanup || cleaning.current) return;
    cleaning.current = true;
    setCleanupError(''); setError(''); setNotice('');
    try {
      const result = await api.deleteSelection(pendingCleanup.kind, pendingCleanup.ids);
      setPendingCleanup(undefined); setSelectedIds([]); setSelecting(false);
      setNotice(result.cleanupPending ? `已清理 ${result.deleted} 项记录，部分原件文件清理未完成，将在重启时重试` : `已清理 ${result.deleted} 项`);
      await refresh().catch(() => setError('清理已完成，但列表刷新失败，请手动刷新'));
    } catch (failure) {
      setCleanupError(String(failure));
    } finally { cleaning.current = false; }
  };
  const recordView = useCallback(async (id: string) => {
    await api.recordView(id, crypto.randomUUID());
    const summaries = await api.summaries();
    setViews(Object.fromEntries(summaries.map(item => [item.conversationId, item.views])));
  }, [api]);
  useEffect(() => { if (selected && category === 'conversations') void recordView(selected).catch(failure => setError(String(failure))); }, [selected, category, recordView]);
  const openConversation = (id: string, target?: ConversationTarget) => {
    if (!conversations.some(item => item.id === id)) { setNotice('原对话已不可用，已保存的内容仍保留'); return; }
    if (selected === id && category === 'conversations') void recordView(id).catch(failure => setError(String(failure)));
    setSelected(id); setCategory('conversations'); setListOpen(false);
    setConversationTarget(target ? { ...target, revision: ++sourceRevision.current } : undefined);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (hasOverlay() || event.defaultPrevented || event.repeat || event.isComposing) return;
      const key = event.key.replace(/^Arrow/, '').replace(' ', 'Space');
      const accelerator = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', key].filter(Boolean).join('+');
      const action = (Object.keys(settings.localShortcuts) as Array<keyof typeof settings.localShortcuts>).find(name => settings.localShortcuts[name] && normalizeAssetAccelerator(settings.localShortcuts[name]) === normalizeAssetAccelerator(accelerator));
      if (!action || (action !== 'search' && (event.target as Element)?.closest('input, textarea, select, [contenteditable="true"]'))) return;
      event.preventDefault();
      if (action === 'search') searchRef.current?.focus();
      else if (action === 'freeze') setSettingsOpen(true);
      else if (action === 'previousBranch' || action === 'nextBranch') { if (category === 'conversations') setBranchRequest({ direction: action === 'previousBranch' ? -1 : 1, revision: Date.now() }); }
      else { setCategory(action); setQuery(''); setListOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settings.localShortcuts, category]);

  const makePrompt = async (content: string, source?: { conversationId: string; messageId?: string }) => {
    setPromptDraft({ revision: ++sourceRevision.current, example: { content, ...source },
      title: Array.from(content.trim().split('\n')[0]).slice(0, 48).join('') || '对话提示词' });
    setCategory('prompts'); setQuery(''); setListOpen(false);
  };
  return <><WindowResizeHandles /><div ref={rootRef} className="assets-view app-shell app-view-root" data-name="assets.container">
    <StandaloneWindowHeader title="AI资产" className="asset-topbar" dataNamePrefix="assets.topbar" leading={<>
      {category === 'conversations' && <IconButton className="asset-list-toggle asset-icon-button" aria-label="打开对话列表" aria-expanded={listOpen} aria-controls="asset-conversations" onClick={() => setListOpen(value => !value)}><List size={16} /></IconButton>}
      <span className="asset-window-title">AI资产</span></>} onOpenSettings={() => setSettingsOpen(true)}
      actions={<IconButton className="asset-icon-button" aria-label="刷新" onClick={() => void run(refresh)}><RefreshCw size={16} /></IconButton>}
      center={<><nav className="asset-categories" aria-label="AI资产分类">
        {categories.map(({ id, label, Icon }) => <button key={id} type="button" aria-label={label} title={label} aria-pressed={category === id} className={category === id ? 'active' : ''} onClick={() => { setCategory(id); setQuery(''); setListOpen(false); }}><Icon size={15} /><span>{label}</span></button>)}
      </nav><label className="asset-search-field"><Search size={15} aria-hidden="true" /><input ref={searchRef} className="asset-search" aria-label="搜索 AI资产" placeholder="搜索资产" value={query} onChange={event => setQuery(event.target.value)} /></label></>} />
    {settingsError && <p className="asset-feedback asset-error" role="alert">{settingsError}</p>}
    {error && <p className="asset-feedback asset-error" role="alert">{error}</p>}
    {notice && <p className="asset-feedback" role="status">{notice}</p>}
    <AssetCollectionStatus onAction={operation => void run(operation)} />
    {category !== 'prompts' && <div className="asset-bulk-toolbar">
      {category === 'files' && <label>来源 <select aria-label="资料来源" value={fileDirection} onChange={event => setFileDirection(event.target.value as typeof fileDirection)}><option value="input">用户发送</option><option value="output">AI 返回（历史）</option><option value="all">全部资料</option></select></label>}
      <span>{selectionItems.length} 项{selecting ? ` · 已选 ${selectedIds.length} 项` : ''}</span>
      {selecting ? <><Button variant="ghost" onClick={() => setSelectedIds(selectedIds.length === selectionItems.length ? [] : selectionItems.map(item => item.id))}>{selectedIds.length === selectionItems.length ? '取消全选' : '全选当前结果'}</Button>
        <Button variant="danger" disabled={!selectedIds.length} onClick={() => setPendingCleanup({ kind: category, ids: [...selectedIds], names: selectionItems.filter(item => selectedIds.includes(item.id)).map(item => item.name) })}>清理所选</Button>
        <Button variant="ghost" onClick={() => { setSelecting(false); setSelectedIds([]); }}>取消多选</Button></> : <Button variant="outline" disabled={!selectionItems.length} onClick={() => setSelecting(true)}>多选清理</Button>}
      {category === 'files' && <small>仅自动收纳用户上传、粘贴或拖入的附件</small>}
    </div>}
    {category === 'prompts' ? <div className="asset-prompt-body">
      {!!suggestions.length && <details className="asset-suggestions" open><summary>自动提取的重点提示词</summary>
        {suggestions.filter(item => !query || item.content.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.messageId}>
          <strong>{item.title}</strong><p title="最近 500 条用户输入中，至少 3 个不同对话的输入与相邻上下文首尾各 10% 达到 80% 相似度；同一对话只计一次">{item.uses} 个对话使用 · 相似内容</p><pre>{item.content}</pre><div className="asset-actions">
            <Button variant="outline" onClick={() => void run(() => makePrompt(item.content, { conversationId: item.conversationId, messageId: item.messageId }))}>保存为模板</Button>
            <Button variant="ghost" onClick={() => openConversation(item.conversationId, { messageId: item.messageId })}>原始对话</Button></div></article>)}
      </details>}<PromptLibraryView embedded query={query} draft={promptDraft} sourceConversationIds={conversations.map(item => item.id)}
        onDraftConsumed={consumed => setPromptDraft(current => current?.revision === consumed ? undefined : current)}
        onOpenSource={example => { if (example.conversationId) openConversation(example.conversationId, { messageId: example.messageId }); }} />
    </div> : category === 'files' ? <main className="asset-file-list">{visibleFiles.length ? visibleFiles.map(item =>
      <AssetFileCard key={item.id} item={item} selected={selectedIds.includes(item.id)} onSelect={selecting ? () => toggleSelection(item.id) : undefined} onConversation={openConversation} onAction={operation => void run(operation)} />) : <EmptyState message="当前范围暂无资料" />}</main>
      : <div className="asset-conversation-body">
        {listOpen && <button className="asset-list-scrim" aria-label="关闭对话列表" onClick={() => setListOpen(false)} />}
        <aside id="asset-conversations" className={`asset-conversations${listOpen ? ' is-open' : ''}`} aria-label="对话列表">
        <div className="asset-list-heading"><span>{visibleConversations.length} 个对话</span><details ref={importMenuRef} className="asset-operation-menu asset-import-menu"><summary aria-label="导入对话" title="导入对话"><Upload size={15} /></summary><div>
          {([['json', 'JSON'], ['md', 'Markdown'], ['deepseek', 'DeepSeek']] as const).map(([format, label]) => <Button key={format} variant="ghost" onClick={() => { if (importMenuRef.current) importMenuRef.current.open = false; void run(async () => { const result = await importConversation(format, 'imported'); if (result.ok) await refresh(); else if (!result.canceled) throw new Error('导入失败'); }); }}>导入 {label}</Button>)}
        </div></details><IconButton className="asset-list-close asset-icon-button" aria-label="关闭对话列表" onClick={() => setListOpen(false)}><X size={15} /></IconButton></div>
        <div className="asset-conversation-list">{!visibleConversations.length && <EmptyState message={query ? '没有匹配的对话' : '交流记录会自动保存在这里'} />}
        {visibleConversations.map(item => <div key={item.id} className="asset-conversation-row">{selecting && <input type="checkbox" aria-label={`选择对话 ${item.title || '未命名对话'}`} checked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} />}<button className={`asset-conversation ${selected === item.id ? 'active' : ''}`} aria-current={selected === item.id ? 'true' : undefined} title={item.title || '未命名对话'} onClick={() => selecting ? toggleSelection(item.id) : openConversation(item.id)}>
          <strong>{item.title || '未命名对话'}</strong><span className="asset-conversation-meta"><span title={conversationPlatform(item)}>{conversationPlatform(item)} · 浏览 {views[item.id] ?? 0}</span><time title={new Date(item.updatedAt).toLocaleString()} dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</time></span></button></div>)}
        </div>
        {totalUsage && <div className="asset-total-usage" data-name="assets.total-usage" title={`全部对话累计 Unicode 字符（含空白与标点）：输入 ${totalUsage.inputCharacters.toLocaleString()} · 思考 ${totalUsage.reasoningCharacters.toLocaleString()} · 输出 ${totalUsage.outputCharacters.toLocaleString()}`}><span>总字符</span><strong>{totalUsage.totalCharacters.toLocaleString()}</strong></div>}
      </aside><main className="asset-conversation-detail"><AssetConversation conversation={conversations.find(item => item.id === selected)} revision={revision}
        attachments={attachments.filter(item => !isAssetInterfaceImage(item))} settings={settings} branchRequest={branchRequest} target={conversationTarget} onAction={operation => void run(operation)} onRefresh={refresh} onPrompt={makePrompt} onConversation={openConversation} /></main></div>}
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="AI资产设置" className="asset-settings-modal" portal><AssetSettingsPanel freezeTarget={freezeTarget} /></Modal>
    <ConfirmDialog open={!!pendingCleanup} title={`清理所选${pendingCleanup?.kind === 'files' ? '资料' : '对话'}`} variant="danger" confirmLabel="确认清理"
      onCancel={() => { if (!cleaning.current) setPendingCleanup(undefined); }} onConfirm={clearSelection}
      message={<>{pendingCleanup?.ids.length} 项：{pendingCleanup?.names.slice(0, 4).join('、')}{(pendingCleanup?.names.length ?? 0) > 4 ? '…' : ''}。{pendingCleanup?.kind === 'files'
        ? '将删除这些资料记录和不再被其他资料引用的原件，无法撤销；保留对话、模板及共享原件。已清理的资料不会自动重新收纳。'
        : '将删除这些对话及消息，无法撤销；保留已保存的模板和本机原件，原网页再次出现时不自动收回。'}{cleanupError && <><br /><span role="alert" className="asset-error">{cleanupError}</span></>}</>} />
  </div></>;
}
