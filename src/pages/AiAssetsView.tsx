import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import StandaloneWindowHeader from '../components/StandaloneWindowHeader';
import { Button, EmptyState } from '../components/ui';
import PromptLibraryView from './PromptLibraryView';
import AssetConversation from './ai-assets/AssetConversation';
import AssetFileCard from './ai-assets/AssetFileCard';
import AssetFreezeControl from './ai-assets/AssetFreezeControl';
import { listConversations, importConversation, onConversationPersisted } from '../lib/electron-api';
import { requireElectron } from '../lib/electron-api/core';
import type { Conversation } from '../lib/electron-api';
import type { AssetAttachment, AssetPromptSuggestion, AssetTextUsage } from '../../electron/shared/ai-assets.types';
import { usePromptStore } from '../store/usePromptStore';
import { useModuleStore } from '../store/useModuleStore';
import { useEscToCloseWindow } from '../hooks/useEscToCloseWindow';
import './AiAssetsView.css';

type Category = 'conversations' | 'prompts' | 'files';
export default function AiAssetsView() {
  const api = requireElectron().aiAssets;
  const promptApi = requireElectron().prompt;
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationRevision = useRef(-1);
  const [freezeTarget, setFreezeTarget] = useState<{ tabId: string; revision: number }>();
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
  const freezeEnabled = useModuleStore(state => state.isEnabled('freeze'));
  const savePrompt = usePromptStore(state => state.save);
  useEscToCloseWindow({ onEsc: () => category === 'prompts', ctrlW: category !== 'prompts' });

  useEffect(() => {
    const navigate = (request: import('../../electron/shared/ai-assets.types').AssetNavigationEvent) => {
      if (request.revision <= navigationRevision.current) return;
      navigationRevision.current = request.revision;
      if (request.category) { setCategory(request.category); setQuery(''); }
      if (request.focusSearch) searchRef.current?.focus();
      if (request.freezeTabId) setFreezeTarget({ tabId: request.freezeTabId, revision: request.revision });
    };
    const off = promptApi.onNavigate(navigate);
    void promptApi.navigation().then(navigate).catch(failure => setError(String(failure)));
    return off;
  }, [promptApi]);

  const refresh = useCallback(async () => {
    const [list, files, text, extracted] = await Promise.all([listConversations(), api.attachments(), api.usage(), api.suggestions()]);
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
  const visibleConversations = useMemo(() => conversations.filter(item => !query || matches.includes(item.id)), [conversations, matches, query]);
  const visibleFiles = useMemo(() => attachments.filter(item => !query || `${item.name} ${item.sourceUrl ?? ''}`.toLowerCase().includes(query.toLowerCase())), [attachments, query]);
  const openConversation = (id: string) => { setSelected(id); setCategory('conversations'); };
  const makePrompt = async (content: string) => {
    const now = Date.now();
    await savePrompt({ id: '', title: Array.from(content.trim().split('\n')[0]).slice(0, 48).join('') || '对话提示词',
      content, category: '来自对话', createdAt: now, updatedAt: now });
    setNotice('已保存为提示词，可在提示词分类中编辑和调用');
  };
  return <><WindowResizeHandles /><div className="assets-view app-shell app-view-root" data-name="assets.container">
    <StandaloneWindowHeader title="AI资产" dataNamePrefix="assets.topbar" />
    <div className="assets-tools"><input ref={searchRef} className="asset-search" aria-label="搜索 AI资产" placeholder="搜索对话、提示词和资料" value={query} onChange={event => setQuery(event.target.value)} />
      <Button variant="outline" onClick={() => void run(refresh)}>刷新</Button></div>
    <nav className="asset-categories" aria-label="资产分类">
      {([['conversations', '对话'], ['prompts', '提示词'], ['files', '资料']] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={category === id} className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>{label}</button>)}
      <Button variant="ghost" onClick={() => void run(async () => {
        const result = await useModuleStore.getState().setEnabled('freeze', !freezeEnabled);
        if (!result.ok) throw new Error(result.error);
      })}>{freezeEnabled ? '页面冻结已启用' : '启用页面冻结'}</Button>
    </nav>
    {freezeEnabled && <AssetFreezeControl target={freezeTarget} onAction={operation => void run(operation)} />}
    {usage && <div className="asset-usage" data-name="assets.text-usage" title="本地字符数，包含空白与标点；未提供的思考文本不推断">
      <strong>文本用量</strong><span>输入 {usage.inputCharacters.toLocaleString()}</span><span>思考 {usage.reasoningCharacters.toLocaleString()}</span>
      <span>输出 {usage.outputCharacters.toLocaleString()}</span><span>共 {usage.totalCharacters.toLocaleString()} 字符</span></div>}
    {error && <p className="asset-feedback asset-error" role="alert">{error}</p>}
    {notice && <p className="asset-feedback" role="status">{notice}</p>}
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
        {!visibleConversations.length && <EmptyState message={query ? '没有匹配的对话' : '交流记录会自动保存在这里'} />}
        {visibleConversations.map(item => <button key={item.id} className={`asset-conversation ${selected === item.id ? 'active' : ''}`} onClick={() => setSelected(item.id)}>
          <strong>{item.title || '未命名对话'}</strong><span>{item.sourceType === 'api' ? 'API 对话' : '网页对话'} · {new Date(item.updatedAt).toLocaleString()}</span></button>)}
      </aside><main className="asset-conversation-detail"><AssetConversation conversation={conversations.find(item => item.id === selected)} revision={revision}
        attachments={attachments} onAction={operation => void run(operation)} onRefresh={refresh} onPrompt={makePrompt} onConversation={openConversation} /></main></div>}
  </div></>;
}
