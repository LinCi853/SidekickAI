import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Files, List, MessageSquare, RefreshCw, Search, SquareLibrary, Upload, X } from 'lucide-react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { Button, EmptyState, IconButton } from '../components/ui';
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
  const [suggestions, setSuggestions] = useState<AssetPromptSuggestion[]>([]);
  const [matches, setMatches] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [promptDraft, setPromptDraft] = useState<{ revision: number; example: PromptExample; title?: string }>();
  const [conversationTarget, setConversationTarget] = useState<ConversationTarget & { revision: number }>();
  useEscToCloseWindow({ onEsc: () => {
    if (rootRef.current?.querySelector('.asset-selection-actions')) { window.getSelection()?.removeAllRanges(); return true; }
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
    setConversations(list); setAttachments(files.filter(item => !isAssetInterfaceImage(item)));
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
  const visibleFiles = useMemo(() => attachments.filter(item => !query || `${item.name} ${item.sourceUrl ?? ''}`.toLowerCase().includes(query.toLowerCase())), [attachments, query]);
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
      <AssetFileCard key={item.id} item={item} onConversation={openConversation} onAction={operation => void run(operation)} />) : <EmptyState message="暂无收纳资料" />}</main>
      : <div className="asset-conversation-body">
        {listOpen && <button className="asset-list-scrim" aria-label="关闭对话列表" onClick={() => setListOpen(false)} />}
        <aside id="asset-conversations" className={`asset-conversations${listOpen ? ' is-open' : ''}`} aria-label="对话列表">
        <div className="asset-list-heading"><span>{visibleConversations.length} 个对话</span><details ref={importMenuRef} className="asset-operation-menu asset-import-menu"><summary aria-label="导入对话" title="导入对话"><Upload size={15} /></summary><div>
          {([['json', 'JSON'], ['md', 'Markdown'], ['deepseek', 'DeepSeek']] as const).map(([format, label]) => <Button key={format} variant="ghost" onClick={() => { if (importMenuRef.current) importMenuRef.current.open = false; void run(async () => { const result = await importConversation(format, 'imported'); if (result.ok) await refresh(); else if (!result.canceled) throw new Error('导入失败'); }); }}>导入 {label}</Button>)}
        </div></details><IconButton className="asset-list-close asset-icon-button" aria-label="关闭对话列表" onClick={() => setListOpen(false)}><X size={15} /></IconButton></div>
        <div className="asset-conversation-list">{!visibleConversations.length && <EmptyState message={query ? '没有匹配的对话' : '交流记录会自动保存在这里'} />}
        {visibleConversations.map(item => <button key={item.id} className={`asset-conversation ${selected === item.id ? 'active' : ''}`} aria-current={selected === item.id ? 'true' : undefined} title={item.title || '未命名对话'} onClick={() => openConversation(item.id)}>
          <strong>{item.title || '未命名对话'}</strong><span className="asset-conversation-meta"><span title={conversationPlatform(item)}>{conversationPlatform(item)} · 浏览 {views[item.id] ?? 0}</span><time title={new Date(item.updatedAt).toLocaleString()} dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</time></span></button>)}
        </div>
        {totalUsage && <div className="asset-total-usage" data-name="assets.total-usage" title={`全部对话累计 Unicode 字符（含空白与标点）：输入 ${totalUsage.inputCharacters.toLocaleString()} · 思考 ${totalUsage.reasoningCharacters.toLocaleString()} · 输出 ${totalUsage.outputCharacters.toLocaleString()}`}><span>总字符</span><strong>{totalUsage.totalCharacters.toLocaleString()}</strong></div>}
      </aside><main className="asset-conversation-detail"><AssetConversation conversation={conversations.find(item => item.id === selected)} revision={revision}
        attachments={attachments} settings={settings} branchRequest={branchRequest} target={conversationTarget} onAction={operation => void run(operation)} onRefresh={refresh} onPrompt={makePrompt} onConversation={openConversation} /></main></div>}
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="AI资产设置" className="asset-settings-modal" portal><AssetSettingsPanel freezeTarget={freezeTarget} /></Modal>
  </div></>;
}
