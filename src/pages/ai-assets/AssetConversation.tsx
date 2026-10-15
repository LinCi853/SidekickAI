import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookPlus, Brain, ChevronDown, ChevronUp, Copy, GitBranch, History, MoreHorizontal, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { Button, EmptyState, IconButton } from '../../components/ui';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { exportConversation, updateMessage } from '../../lib/electron-api';
import { requireElectron } from '../../lib/electron-api/core';
import type { Conversation } from '../../lib/electron-api';
import type { AssetAttachment, AssetConversationGraph, AssetGraphNode, AssetMessageDetail, AssetSettings, AssetTextUsage } from '../../../electron/shared/ai-assets.types';
import AssetFileCard from './AssetFileCard';
import AssetMarkdown from './AssetMarkdown';
import { conversationAiLabel, displayConversationTitle } from './asset-platform';
import { cleanCapturedCodeToolbar } from '../../../electron/shared/asset-presentation';

const statuses: Record<string, string> = { streaming: '接收中', complete: '已记录', withdrawn: '已撤回，原文保留', retained: '原文保留', stopped: '主动停止', failed: '异常中断' };
// 长消息默认折叠：只按换行判断（约 18 行以上），折叠态保留 markdown 渲染并向下渐变虚影收尾，
// 头部工具栏与底部横条都可展开/收起
const FOLD_LINES = 18;
// 对话内定位点：以「我发送的消息」为一组——一条用户消息与其后的 AI 回复合为一轮，
// 定位按轮次而不是逐条消息；轮次超出上限时按轮次合并取样，保证定位列高度可控且悬停预览不被裁剪
const RAIL_MAX_PILLS = 32;
function railGroups(messages: AssetGraphNode[]): AssetGraphNode[][] {
  const turns: AssetGraphNode[][] = [];
  for (const message of messages) {
    const current = turns[turns.length - 1];
    if (!current || message.role === 'user') turns.push([message]);
    else current.push(message);
  }
  if (turns.length <= RAIL_MAX_PILLS) return turns;
  const size = Math.ceil(turns.length / RAIL_MAX_PILLS);
  const groups: AssetGraphNode[][] = [];
  for (let index = 0; index < turns.length; index += size) groups.push(turns.slice(index, index + size).flat());
  return groups;
}
function RevisionDifference({ before, after }: { before: string; after: string }) {
  const old = Array.from(before), next = Array.from(after);
  let start = 0, end = 0;
  while (start < Math.min(old.length, next.length) && old[start] === next[start]) start++;
  while (end < Math.min(old.length, next.length) - start && old[old.length - end - 1] === next[next.length - end - 1]) end++;
  return <pre className="asset-diff">{old.slice(0, start).join('')}<del>{old.slice(start, old.length - end).join('')}</del><ins>{next.slice(start, next.length - end).join('')}</ins>{end ? old.slice(-end).join('') : ''}</pre>;
}
interface AssetConversationProps {
  conversation?: Conversation; revision: number; attachments: AssetAttachment[]; settings: AssetSettings;
  branchRequest?: { direction: number; revision: number };
  target?: { revision: number; messageId?: string; attachmentId?: string };
  onAction: (operation: () => Promise<void>) => void; onRefresh: () => Promise<void>;
  onPrompt: (content: string, source?: { conversationId: string; messageId?: string }) => Promise<void>;
  onConversation: (id: string, target?: { messageId?: string; attachmentId?: string }) => void;
}
const emptyGraph: AssetConversationGraph = { nodes: [], path: [], sourcePath: [] };
export default function AssetConversation(props: AssetConversationProps) {
  if (!props.conversation) return <EmptyState message="选择对话查看完整记录" />;
  return <ConversationDetail key={props.conversation.id} {...props} conversation={props.conversation} />;
}
function ConversationDetail({ conversation, revision, attachments, settings, branchRequest, target, onAction, onRefresh, onPrompt, onConversation }: AssetConversationProps & { conversation: Conversation }) {
  const api = requireElectron().aiAssets;
  const [loaded, setLoaded] = useState<{ graph: AssetConversationGraph; details: AssetMessageDetail[]; usage?: AssetTextUsage } | null>(null);
  const [loading, setLoading] = useState(true);
  const { graph = emptyGraph, details = [], usage } = loaded ?? {};
  const request = useRef(0);
  const mounted = useRef(false);
  const owns = (operation: number) => mounted.current && operation === request.current;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingDelete, setPendingDelete] = useState<'conversation' | string>();
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [rename, setRename] = useState<string>();
  // 详情标题重命名无独立按钮：Enter/失焦提交，Escape 取消（取消标记避免失焦误提交）
  const renameCancelled = useRef(false);
  // 消息折叠状态：长消息默认折叠，键为消息 id；未记录时按内容长度取默认值
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<{ content: string; messageId?: string; left: number; top: number }>();
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selection) return;
    const clear = () => { if (!window.getSelection()?.toString()) setSelection(undefined); };
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest('.asset-selection-actions')) setSelection(undefined); };
    document.addEventListener('selectionchange', clear);
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', clearSelection);
    function clearSelection() { setSelection(undefined); }
    return () => {
      document.removeEventListener('selectionchange', clear);
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', clearSelection);
    };
  }, [selection]);
  useEffect(() => { setSelection(undefined); }, [graph]);
  // 右缘消息定位点：滚动跟随高亮当前消息，点击定位到对应消息（是定位，不是筛选）
  const [activeMessageId, setActiveMessageId] = useState<string>();
  useEffect(() => {
    const body = bodyRef.current;
    // ref 可能被测试替身替换成普通对象，缺少真实元素 API 时不挂滚动跟随
    if (loading || typeof body?.addEventListener !== 'function' || typeof body?.querySelectorAll !== 'function'
      || typeof body?.getBoundingClientRect !== 'function' || typeof body?.removeEventListener !== 'function') return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const marks = body.querySelectorAll<HTMLElement>('[data-name="assets.message"]');
      if (!marks.length) { setActiveMessageId(undefined); return; }
      const bounds = body.getBoundingClientRect();
      let current = marks[0].getAttribute('data-id') ?? undefined;
      for (const mark of marks) {
        if (mark.getBoundingClientRect().top - bounds.top > 120) break;
        current = mark.getAttribute('data-id') ?? current;
      }
      setActiveMessageId(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    body.addEventListener('scroll', schedule, { passive: true });
    update();
    return () => { body.removeEventListener('scroll', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [loading, graph]);
  const scrollToMessage = (id: string) => {
    bodyRef.current?.querySelector<HTMLElement>(`[data-name="assets.message"][data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const readSelection = () => {
    const value = window.getSelection();
    if (!value?.anchorNode || !value.focusNode || !value.rangeCount || !bodyRef.current?.contains(value.anchorNode) || !bodyRef.current.contains(value.focusNode) || !value.toString()) { setSelection(undefined); return; }
    const sourceMessage = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('[data-name="assets.message"]')?.dataset.id;
    const anchor = sourceMessage(value.anchorNode), focus = sourceMessage(value.focusNode);
    if (!anchor || !focus || (value.focusNode.parentElement?.closest('textarea, input'))) { setSelection(undefined); return; }
    const range = value.getRangeAt(0);
    const rects = Array.from(range.getClientRects());
    const reversed = value.focusNode === range.startContainer && value.focusOffset === range.startOffset;
    const rect = (reversed ? rects[0] : rects.at(-1)) ?? range.getBoundingClientRect();
    const bounds = bodyRef.current.getBoundingClientRect();
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) { setSelection(undefined); return; }
    const left = Math.max(bounds.left + 4, Math.min(rect.right - 38, bounds.right - 80, window.innerWidth - 80));
    const top = rect.bottom + 44 < Math.min(bounds.bottom, window.innerHeight) ? rect.bottom + 6 : Math.max(bounds.top + 4, rect.top - 42);
    setSelection({ content: value.toString(), messageId: anchor === focus ? anchor : undefined, left, top });
  };
  const targetRevision = useRef(-1);
  const pendingScroll = useRef<{ revision: number; messageId?: string; attachmentId?: string }>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);
  useEffect(() => {
    const operation = ++request.current;
    setLoading(true);
    setError('');
    void Promise.all([api.graph(conversation.id), api.details(conversation.id), api.usage(undefined, conversation.id)]).then(([value, states, text]) => {
      if (!owns(operation)) return;
      // 流式输出期间不更新已显示的内容，避免持续刷新闪烁；首次显示照常应用，落定后由下一次观察一次性应用
      if (states.some(item => item.status === 'streaming')) {
        setLoaded(current => current ?? { graph: value, details: states, usage: text });
        setLoading(false);
        return;
      }
      setLoaded({ graph: value, details: states, usage: text });
      setLoading(false);
    }).catch(failure => { if (owns(operation)) { setError(String(failure)); setLoading(false); } });
    return () => { request.current += 1; };
  }, [api, conversation.id, revision]);
  const siblings = (message: AssetGraphNode) => graph.nodes.filter(node => node.parentId === message.parentId && node.role === message.role);
  const switchBranch = async (message: AssetGraphNode, direction: number) => {
    if (!mounted.current || loading || !loaded || message.conversationId !== conversation.id) return;
    const known = siblings(message);
    const index = message.branchIndex ?? known.findIndex(node => node.id === message.id) + 1;
    const target = index + direction;
    const candidate = known.find(node => (node.branchIndex ?? known.findIndex(value => value.id === node.id) + 1) === target);
    if (!candidate) { setError('此分支尚未收纳，请在原网页浏览后再查看。'); return; }
    const operation = ++request.current;
    setError(''); setLoading(true);
    try {
      const value = await api.selectBranch(conversation.id, candidate.id);
      if (owns(operation)) { setLoaded(current => current && { ...current, graph: value }); setSelection(undefined); setLoading(false); }
    } catch (failure) {
      if (owns(operation)) { setError(String(failure)); setLoading(false); }
    }
  };
  const requestRef = useRef(-1);
  useEffect(() => {
    if (!branchRequest || requestRef.current === branchRequest.revision) return;
    requestRef.current = branchRequest.revision;
    const message = [...graph.path].reverse().map(id => graph.nodes.find(node => node.id === id)!).find(node => siblings(node).length > 1 || (node.branchCount ?? 1) > 1);
    if (message && !loading) onAction(() => switchBranch(message, branchRequest.direction));
  }, [branchRequest, graph, loading]);
  useEffect(() => {
    if (!target || targetRevision.current === target.revision || loading || !loaded) return;
    setNotice(''); setSelection(undefined);
    const attachment = target.attachmentId ? attachments.find(item => item.id === target.attachmentId && item.conversationId === conversation.id) : undefined;
    const messageId = target.messageId ?? attachment?.messageId;
    const node = messageId ? graph.nodes.find(item => item.id === messageId) : undefined;
    if (messageId && !node) setNotice('原消息已不可用，已打开原对话；案例快照仍保留');
    if (target.attachmentId && !attachment) setNotice('原资料定位已不可用，已打开原对话');
    const location = { revision: target.revision, messageId: node?.id, attachmentId: attachment?.id };
    if (!node || graph.path.includes(node.id)) { targetRevision.current = target.revision; pendingScroll.current = location; return; }
    pendingScroll.current = undefined;
    const operation = ++request.current;
    setError(''); setLoading(true);
    void api.selectBranch(conversation.id, node.id).then(value => {
      if (!owns(operation)) return;
      targetRevision.current = target.revision;
      if (!value.path.includes(node.id)) setNotice('此消息所在分支尚未收纳，已打开原对话');
      else pendingScroll.current = location;
      setLoaded(current => current && { ...current, graph: value }); setLoading(false);
    }).catch(failure => { if (owns(operation)) { targetRevision.current = target.revision; setError(String(failure)); pendingScroll.current = undefined; setLoading(false); } });
  }, [api, attachments, conversation.id, graph, loaded, loading, target]);
  useEffect(() => {
    if (loading || !loaded || !pendingScroll.current || !bodyRef.current) return;
    const location = pendingScroll.current;
    pendingScroll.current = undefined;
    if (location.revision !== target?.revision) return;
    const elements = Array.from(bodyRef.current.querySelectorAll<HTMLElement>('[data-id]'));
    const element = elements.find(item => item.dataset.id === (location.attachmentId ?? location.messageId));
    const group = element?.closest<HTMLDetailsElement>('.asset-attachment-group');
    if (group) group.open = true;
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [graph, loaded, loading, target]);
  // 后台刷新期间保留已显示内容，不再回到「正在加载对话」空态（流式时页面不闪白）
  if (!loaded) return <><div className="asset-detail-heading"><h2>{displayConversationTitle(conversation)}</h2></div>
    {error && <p className="asset-error" role="alert">{error}</p>}
    <EmptyState message={loading ? '正在加载对话' : '无法加载对话，请刷新后重试'} /></>;
  const files = (items: AssetAttachment[]) => !!items.length && <details className="asset-attachment-group">
    <summary><Paperclip size={15} aria-hidden="true" /><span className="asset-attachment-count">{items.length} 份资料</span>
      <span className="asset-attachment-names" title={items.map(item => item.name).join('、')}>{items.map(item => item.name).join('、')}</span>
      {items.some(item => item.status === 'failed') && <span className="asset-attachment-failure">{items.filter(item => item.status === 'failed').length} 份获取失败</span>}
      {items.some(item => item.status === 'pending') && <span className="asset-attachment-pending">待获取</span>}
    </summary><div className="asset-file-grid">{items.map(item => <AssetFileCard key={item.id} item={item} onAction={onAction} onConversation={onConversation} showConversation={false} />)}</div>
  </details>;
  const messages = graph.path.map(id => graph.nodes.find(node => node.id === id)!).filter(Boolean);
  const rail = railGroups(messages);
  const aiLabel = conversationAiLabel(conversation);
  return <><div className="asset-detail-heading">
    <div className="asset-detail-title" onKeyDown={event => { if (event.key === 'F2' && rename === undefined) { event.preventDefault(); setRename(conversation.title); } }}>{rename !== undefined ? <div className="asset-actions"><input aria-label="本地对话名称" autoFocus value={rename} onChange={event => setRename(event.target.value)}
      onBlur={() => { if (renameCancelled.current) { renameCancelled.current = false; return; } onAction(async () => { if (rename.trim() && rename !== conversation.title) await api.renameConversation(conversation.id, rename.trim()); setRename(undefined); await onRefresh(); }); }}
      onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); else if (event.key === 'Escape') { renameCancelled.current = true; setRename(undefined); } }} /></div>
      : <h2 tabIndex={0} style={{ cursor: 'default' }} title="重命名（F2）">{displayConversationTitle(conversation)}</h2>}
      <details className="asset-operation-menu"><summary aria-label="对话操作" title="对话操作"><MoreHorizontal size={18} /></summary><div>
        <Button variant="ghost" onClick={() => setRename(conversation.title)}>本地重命名</Button>
        {(['md', 'json'] as const).map(format => <Button key={format} variant="ghost" onClick={() => onAction(async () => { const result = await exportConversation(conversation.id, format); if (!result.ok && !result.canceled) throw new Error('导出失败'); })}>导出 {format.toUpperCase()}</Button>)}
        {conversation.url && <Button variant="ghost" onClick={() => onAction(() => api.openExternal(conversation.url!))}>打开原网页</Button>}
        <Button variant="danger" onClick={() => setPendingDelete('conversation')}>删除对话</Button></div></details>
    </div>
    {usage && <div className="asset-usage" data-name="assets.conversation-usage" title="此对话累计的 Unicode 字符，包含空白与标点；已知版本不会重复计数">
      <span>输入 {usage.inputCharacters.toLocaleString()}</span><span>思考 {usage.reasoningCharacters.toLocaleString()}</span><span>输出 {usage.outputCharacters.toLocaleString()}</span></div>}
  </div>
  {error && <p className="asset-error" role="alert">{error}</p>}
  {notice && <p className="asset-feedback" role="status">{notice}</p>}
  <div className="asset-chat-scroll" ref={bodyRef} onScroll={() => setSelection(undefined)} onMouseUp={event => {
    if (!(event.target as Element).closest('.asset-selection-actions')) readSelection();
  }} onKeyUp={event => { if (event.key.startsWith('Arrow') && event.shiftKey) readSelection(); }}>
    {selection && <div className="asset-selection-actions" style={{ left: selection.left, top: selection.top }} role="toolbar" aria-label="选中文字操作" onMouseDown={event => event.preventDefault()}>
      <IconButton className="asset-icon-button" aria-label="复制选中内容" onClick={() => onAction(() => api.copyText(selection.content))}><Copy size={16} /></IconButton>
      <IconButton className="asset-icon-button" aria-label="选中内容存为提示词" onClick={() => onAction(() => onPrompt(selection.content, { conversationId: conversation.id, messageId: selection.messageId }))}><BookPlus size={16} /></IconButton>
    </div>}
    {!messages.length && <EmptyState message="尚未取得对话文本，等待交流内容出现" />}
    {messages.map(message => {
      const detail = details.find(item => item.messageId === message.id);
      const captured = !message.locallyEdited && detail?.markdownContent;
      const content = captured && message.role === 'assistant' && /^https:\/\/chat\.deepseek\.com(?:\/|$)/i.test(conversation.url ?? '')
        ? cleanCapturedCodeToolbar(captured) : captured || message.content;
      const known = siblings(message);
      const branchCount = Math.max(message.branchCount ?? 1, known.length);
      const branchIndex = message.branchIndex ?? known.findIndex(node => node.id === message.id) + 1;
      const foldable = content.split('\n').length >= FOLD_LINES;
      const foldedNow = foldable && (folded[message.id] ?? true);
      const toggleFold = () => setFolded(current => ({ ...current, [message.id]: !(folded[message.id] ?? true) }));
      return <article className={`asset-message asset-message-${message.role}`} key={message.id} data-name="assets.message" data-id={message.id}>
        <div className={`asset-bubble${foldedNow ? ' folded' : ''}`}>
          <header><strong>{message.role === 'user' ? '我' : message.role === 'system' ? '系统提示' : aiLabel}</strong><span className={`asset-status ${detail?.status ?? 'complete'}`}>{statuses[detail?.status ?? 'complete']}</span>{message.locallyEdited && <span>本地编辑</span>}
            {branchCount > 1 && <div className="asset-branch" aria-label="消息分支"><GitBranch size={14} aria-hidden="true" /><IconButton className="asset-icon-button" aria-label="上一个分支" disabled={branchIndex <= 1} onClick={() => onAction(() => switchBranch(message, -1))}><ArrowLeft size={14} /></IconButton><span>{branchIndex}/{branchCount}</span><IconButton className="asset-icon-button" aria-label="下一个分支" disabled={branchIndex >= branchCount} onClick={() => onAction(() => switchBranch(message, 1))}><ArrowRight size={14} /></IconButton>{known.length < branchCount && <span className="asset-branch-missing">部分分支尚未收纳</span>}</div>}
            <span className="asset-message-tools">
              {foldable && <IconButton className="asset-icon-button" aria-label={foldedNow ? '展开消息' : '折叠消息'} onClick={toggleFold}>{foldedNow ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</IconButton>}
              <IconButton className="asset-icon-button" aria-label="复制消息" onClick={() => onAction(() => api.copyText(message.content))}><Copy size={15} /></IconButton>
              <IconButton className="asset-icon-button" aria-label="编辑消息" onClick={() => { setEditing({ id: message.id, content: message.content }); if (foldable) setFolded(current => ({ ...current, [message.id]: false })); }}><Pencil size={15} /></IconButton>
              <IconButton className="asset-icon-button" aria-label="存为提示词" onClick={() => onAction(() => onPrompt(message.content, { conversationId: conversation.id, messageId: message.id }))}><BookPlus size={15} /></IconButton>
              <IconButton className="asset-icon-button" aria-label="删除消息" onClick={() => setPendingDelete(message.id)}><Trash2 size={15} /></IconButton>
            </span>
            <time title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time></header>
          {foldedNow ? <>
              <div className="asset-message-folded" onClick={toggleFold}><AssetMarkdown content={content} onAction={onAction} /></div>
              <button type="button" className="asset-fold-bar" onClick={toggleFold}>展开全部<ChevronDown size={14} aria-hidden="true" /></button>
            </>
            : <>
          {message.role === 'assistant' && !!detail?.reasoning && <details key={`${message.id}:${settings.expandReasoning}`} className="asset-thinking" open={settings.expandReasoning || undefined}><summary><Brain size={14} aria-hidden="true" />思考 · {detail.reasoningCharacters.toLocaleString()} 字符</summary><AssetMarkdown content={detail.reasoning} onAction={onAction} /></details>}
          {editing?.id === message.id ? <><textarea className="asset-message-editor" aria-label="编辑消息" value={editing.content} onChange={event => setEditing({ id: message.id, content: event.target.value })} /><div className="asset-actions"><Button variant="primary" onClick={() => onAction(async () => { await updateMessage(message.id, { content: editing.content }); setEditing(null); await onRefresh(); })}>保存本地编辑</Button><Button variant="outline" onClick={() => setEditing(null)}>取消</Button></div></> : <AssetMarkdown content={content} onAction={onAction} />}
          {foldable && <button type="button" className="asset-fold-bar" onClick={toggleFold}>收起<ChevronUp size={14} aria-hidden="true" /></button>}
          {!!detail?.revisions.length && <details className="asset-revisions"><summary><History size={14} aria-hidden="true" />修订记录 · {detail.revisions.length}</summary>{detail.revisions.map((item, index) => <div key={item.id}><span>{new Date(item.capturedAt).toLocaleString()} · {statuses[item.status]}</span>{item.reasoning && <details><summary>当时的思考</summary><pre>{item.reasoning}</pre></details>}{settings.revisionDisplay === 'diff' ? <RevisionDifference before={item.content} after={detail.revisions[index + 1]?.content ?? message.content} /> : <pre>{item.content}</pre>}</div>)}</details>}
          {files(attachments.filter(item => item.conversationId === conversation.id && item.messageId === message.id))}
            </>}
        </div>
      </article>;
    })}
    {files(attachments.filter(item => item.conversationId === conversation.id && (!item.messageId || !graph.nodes.some(node => node.id === item.messageId))))}
  </div>
  {rail.length > 1 && <nav className="asset-message-rail" aria-label="对话内快速切换">
    {rail.map(group => {
      const anchor = group[0];
      const active = !!activeMessageId && group.some(message => message.id === activeMessageId);
      return <div key={anchor.id} className={`asset-message-rail-pill${anchor.role === 'user' ? ' from-user' : ''}${active ? ' active' : ''}`}>
        <button type="button" aria-label={`定位到${anchor.role === 'user' ? '我' : aiLabel}的消息`} onClick={() => scrollToMessage(anchor.id)} />
        <div className="asset-message-rail-preview" role="tooltip">
          <strong>{anchor.role === 'user' ? '我' : aiLabel}{group.length > 1 ? ` · ${group.length} 条消息` : ''}</strong>
          <span>{Array.from(anchor.content.replace(/```+\w*\n?/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 160).join('')}</span>
        </div>
      </div>;
    })}
  </nav>}
  <ConfirmDialog open={!!pendingDelete} title={pendingDelete === 'conversation' ? '删除对话' : '删除消息'} message="仅删除本地内容并建立排除标记，避免自动收纳补回；原网页不受影响，已保存的资料原件保留。" variant="danger" onCancel={() => setPendingDelete(undefined)} onConfirm={() => onAction(async () => { if (pendingDelete === 'conversation') await api.deleteConversation(conversation.id); else if (pendingDelete) await api.deleteMessage(pendingDelete); setPendingDelete(undefined); await onRefresh(); })} />
  </>;
}
