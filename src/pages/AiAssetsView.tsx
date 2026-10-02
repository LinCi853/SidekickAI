import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { Button, EmptyState } from '../components/ui';
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
import type { Conversation } from '../lib/electron-api';
import type { AssetAttachment, AssetPromptSuggestion, AssetTextUsage } from '../../electron/shared/ai-assets.types';
import { usePromptStore } from '../store/usePromptStore';
import { useEscToCloseWindow, hasOverlay } from '../hooks/useEscToCloseWindow';
import './AiAssetsView.css';

type Category = 'conversations' | 'prompts' | 'files';
export default function AiAssetsView() {
  const api = requireElectron().aiAssets;
  const promptApi = requireElectron().prompt;
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationRevision = useRef(-1);
  const [freezeTarget, setFreezeTarget] = useState<{ tabId: string; revision: number }>();
  const { settings, error: settingsError } = useAssetSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [views, setViews] = useState<Record<string, number>>({});
  const [branchRequest, setBranchRequest] = useState<{ direction: number; revision: number }>();
  const [category, setCategory] = useState<Category>('conversations');
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AssetAttachment[]>([]);
  const [suggestions, setSuggestions] = useState<AssetPromptSuggestion[]>([]);
  const [matches, setMatches] = useState<string[]>([]);
  const [usage, setUsage] = useState<AssetTextUsage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [importFormat, setImportFormat] = useState<'json' | 'md' | 'deepseek'>('json');
  const savePrompt = usePromptStore(state => state.save);
  useEscToCloseWindow({ onEsc: () => category === 'prompts', ctrlW: category !== 'prompts' });

  useEffect(() => {
    const navigate = (request: import('../../electron/shared/ai-assets.types').AssetNavigationEvent) => {
      if (request.revision <= navigationRevision.current) return;
      navigationRevision.current = request.revision;
      if (request.category) { setCategory(request.category); setQuery(''); }
      if (request.focusSearch) searchRef.current?.focus();
      if (request.freezeTabId) { setFreezeTarget({ tabId: request.freezeTabId, revision: request.revision }); setSettingsOpen(true); }
      if (request.openSettings) setSettingsOpen(true);
    };
    const off = promptApi.onNavigate(navigate);
    void promptApi.navigation().then(navigate).catch(failure => setError(String(failure)));
    return off;
  }, [promptApi]);

  const refresh = useCallback(async () => {
    const [list, files, text, extracted, summaries] = await Promise.all([listConversations(), api.attachments(), api.usage(), api.suggestions(), api.summaries()]);
    setViews(Object.fromEntries(summaries.map(item => [item.conversationId, item.views])));
    setConversations(list); setAttachments(files); setUsage(text); setSuggestions(extracted);
    setSelected(current => current && list.some(item => item.id === current) ? current : list[0]?.id ?? null);
    setRevision(value => value + 1);
  }, [api]);
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
  const openConversation = (id: string) => { if (selected === id && category === 'conversations') void recordView(id).catch(failure => setError(String(failure))); setSelected(id); setCategory('conversations'); };
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
      else { setCategory(action); setQuery(''); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settings.localShortcuts, category]);

  const makePrompt = async (content: string) => {
    const now = Date.now();
    await savePrompt({ id: '', title: Array.from(content.trim().split('\n')[0]).slice(0, 48).join('') || '对话提示词',
      content, category: '来自对话', createdAt: now, updatedAt: now });
    setNotice('已保存为提示词，可在提示词分类中编辑和调用');
  };
  return <><WindowResizeHandles /><div className="assets-view app-shell app-view-root" data-name="assets.container">
    <StandaloneWindowHeader title="AI资产" dataNamePrefix="assets.topbar" leading={<span className="asset-window-title">AI资产</span>} onOpenSettings={() => setSettingsOpen(true)} center={<nav className="asset-categories" aria-label="资产分类">
      {([['conversations', '对话'], ['prompts', '提示词'], ['files', '资料']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={category === id} className={category === id ? 'active' : ''} onClick={() => { setCategory(id); setQuery(''); }}>{label}</button>)}
    </nav>} />
    <div className="assets-tools"><input ref={searchRef} className="asset-search" aria-label="搜索 AI资产" placeholder="搜索对话、提示词和资料" value={query} onChange={event => setQuery(event.target.value)} /><Button variant="outline" onClick={() => void run(refresh)}>刷新</Button></div>
    {settingsError && <p className="asset-feedback asset-error" role="alert">{settingsError}</p>}
    {error && <p className="asset-feedback asset-error" role="alert">{error}</p>}
    {notice && <p className="asset-feedback" role="status">{notice}</p>}
    <AssetCollectionStatus onAction={operation => void run(operation)} />
    {category === 'prompts' ? <div className="asset-prompt-body">
      {!!suggestions.length && <details className="asset-suggestions" open><summary>自动提取的重点提示词</summary>
        {suggestions.filter(item => !query || item.content.toLowerCase().includes(query.toLowerCase())).map(item => <article key={item.messageId}>
          <strong>{item.title}</strong><p title="统计最近 500 条用户输入">近期使用 {item.uses} 次 · 本地整理</p><pre>{item.content}</pre><div className="asset-actions">
            <Button variant="outline" onClick={() => void run(() => makePrompt(item.content))}>保存为模板</Button>
            <Button variant="ghost" onClick={() => openConversation(item.conversationId)}>原始对话</Button></div></article>)}
      </details>}<PromptLibraryView embedded query={query} />
    </div> : category === 'files' ? <main className="asset-file-list">{visibleFiles.length ? visibleFiles.map(item =>
      <AssetFileCard key={item.id} item={item} onConversation={openConversation} onAction={operation => void run(operation)} />) : <EmptyState message="暂无收纳资料" />}</main>
      : <div className="asset-conversation-body"><aside className="asset-conversations" aria-label="对话列表">
        <div className="asset-actions"><select aria-label="对话导入格式" value={importFormat} onChange={event => setImportFormat(event.target.value as typeof importFormat)}>
          <option value="json">JSON</option><option value="md">Markdown</option><option value="deepseek">DeepSeek</option></select>
          <Button variant="outline" onClick={() => void run(async () => { const result = await importConversation(importFormat, 'imported'); if (result.ok) await refresh(); })}>导入对话</Button></div>
        <div className="asset-conversation-list">{!visibleConversations.length && <EmptyState message={query ? '没有匹配的对话' : '交流记录会自动保存在这里'} />}
        {visibleConversations.map(item => <button key={item.id} className={`asset-conversation ${selected === item.id ? 'active' : ''}`} onClick={() => openConversation(item.id)}>
          <strong>{item.title || '未命名对话'}</strong><span>{item.sourceType === 'api' ? 'API 对话' : '网页对话'} · 浏览 {views[item.id] ?? 0} 次</span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>)}
        </div>{usage && <footer className="asset-total-usage" data-name="assets.text-usage" title="全部对话累计 Unicode 字符，包含空白与标点"><strong>全部文本总计</strong><span>{usage.totalCharacters.toLocaleString()} 字符</span></footer>}
      </aside><main className="asset-conversation-detail"><AssetConversation conversation={conversations.find(item => item.id === selected)} revision={revision}
        attachments={attachments} settings={settings} branchRequest={branchRequest} onAction={operation => void run(operation)} onRefresh={refresh} onPrompt={makePrompt} onConversation={openConversation} /></main></div>}
    <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="AI资产设置" className="asset-settings-modal" portal><AssetSettingsPanel freezeTarget={freezeTarget} /></Modal>
  </div></>;
}
