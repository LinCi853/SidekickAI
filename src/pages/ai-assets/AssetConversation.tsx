import { useEffect, useRef, useState } from 'react';
import { Button, EmptyState } from '../../components/ui';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { exportConversation, updateMessage, openExternal } from '../../lib/electron-api';
import { requireElectron } from '../../lib/electron-api/core';
import type { Conversation } from '../../lib/electron-api';
import type { AssetAttachment, AssetConversationGraph, AssetGraphNode, AssetMessageDetail, AssetSettings, AssetTextUsage } from '../../../electron/shared/ai-assets.types';
import AssetFileCard from './AssetFileCard';
import AssetMarkdown from './AssetMarkdown';

const statuses: Record<string, string> = { streaming: '接收中', complete: '已记录', withdrawn: '已撤回，原文保留', retained: '原文保留', stopped: '主动停止', failed: '异常中断' };
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
  onAction: (operation: () => Promise<void>) => void; onRefresh: () => Promise<void>;
  onPrompt: (content: string) => Promise<void>; onConversation: (id: string) => void;
}
const emptyGraph: AssetConversationGraph = { nodes: [], path: [], sourcePath: [] };
export default function AssetConversation(props: AssetConversationProps) {
  if (!props.conversation) return <EmptyState message="选择对话查看完整记录" />;
  return <ConversationDetail key={props.conversation.id} {...props} conversation={props.conversation} />;
}
function ConversationDetail({ conversation, revision, attachments, settings, branchRequest, onAction, onRefresh, onPrompt, onConversation }: AssetConversationProps & { conversation: Conversation }) {
  const api = requireElectron().aiAssets;
  const [loaded, setLoaded] = useState<{ graph: AssetConversationGraph; details: AssetMessageDetail[]; usage?: AssetTextUsage } | null>(null);
  const [loading, setLoading] = useState(true);
  const { graph = emptyGraph, details = [], usage } = loaded ?? {};
  const request = useRef(0);
  const mounted = useRef(false);
  const owns = (operation: number) => mounted.current && operation === request.current;
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<'conversation' | string>();
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [rename, setRename] = useState<string>();
  const [selection, setSelection] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current += 1; };
  }, []);
  useEffect(() => {
    const operation = ++request.current;
    setLoading(true);
    setError('');
    void Promise.all([api.graph(conversation.id), api.details(conversation.id), api.usage(undefined, conversation.id)]).then(([value, states, text]) => {
      if (owns(operation)) { setLoaded({ graph: value, details: states, usage: text }); setLoading(false); }
    }).catch(failure => { if (owns(operation)) { setLoaded(null); setError(String(failure)); setLoading(false); } });
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
      if (owns(operation)) { setLoaded(current => current && { ...current, graph: value }); setSelection(''); setLoading(false); }
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
  if (loading || !loaded) return <><div className="asset-detail-heading"><h2>{conversation.title}</h2></div>
    {error && <p className="asset-error" role="alert">{error}</p>}
    <EmptyState message={loading ? '正在加载对话' : '无法加载对话，请刷新后重试'} /></>;
  const file = (item: AssetAttachment) => <AssetFileCard key={item.id} item={item} onAction={onAction} onConversation={onConversation} />;
  const messages = graph.path.map(id => graph.nodes.find(node => node.id === id)!).filter(Boolean);
  return <><div className="asset-detail-heading">
    <div className="asset-detail-title">{rename !== undefined ? <div className="asset-actions"><input aria-label="本地对话名称" value={rename} onChange={event => setRename(event.target.value)} /><Button variant="primary" onClick={() => onAction(async () => { await api.renameConversation(conversation.id, rename); setRename(undefined); await onRefresh(); })}>保存名称</Button><Button variant="ghost" onClick={() => setRename(undefined)}>取消</Button></div> : <h2>{conversation.title}</h2>}
      <details className="asset-operation-menu"><summary aria-label="对话操作">•••</summary><div>
        <Button variant="ghost" onClick={() => setRename(conversation.title)}>本地重命名</Button>
        {(['md', 'json'] as const).map(format => <Button key={format} variant="ghost" onClick={() => onAction(async () => { const result = await exportConversation(conversation.id, format); if (!result.ok && !result.canceled) throw new Error('导出失败'); })}>导出 {format.toUpperCase()}</Button>)}
        {conversation.url && <Button variant="ghost" onClick={() => onAction(() => openExternal(conversation.url!))}>打开原网页</Button>}
        <Button variant="danger" onClick={() => setPendingDelete('conversation')}>删除对话</Button></div></details>
    </div>
    {usage && <div className="asset-usage" data-name="assets.conversation-usage" title="此对话累计的 Unicode 字符，包含空白与标点；已知版本不会重复计数">
      <span>输入 {usage.inputCharacters.toLocaleString()}</span><span>思考 {usage.reasoningCharacters.toLocaleString()}</span><span>输出 {usage.outputCharacters.toLocaleString()}</span></div>}
  </div>
  {error && <p className="asset-error" role="alert">{error}</p>}
  <div className="asset-chat-scroll" ref={bodyRef} onMouseUp={event => { if ((event.target as Element).closest('.asset-selection-actions')) return; const value = window.getSelection(); setSelection(value?.anchorNode && bodyRef.current?.contains(value.anchorNode) && value.focusNode && bodyRef.current.contains(value.focusNode) ? value.toString() : ''); }}>
    {selection && <div className="asset-selection-actions" role="toolbar" aria-label="选中文字操作" onMouseDown={event => event.preventDefault()}><Button variant="outline" onClick={() => onAction(() => api.copyText(selection))}>复制选中内容</Button><Button variant="primary" onClick={() => onAction(() => onPrompt(selection))}>选中内容存为提示词</Button></div>}
    {!messages.length && <EmptyState message="尚未取得对话文本，等待交流内容出现" />}
    {messages.map(message => {
      const detail = details.find(item => item.messageId === message.id);
      const known = siblings(message);
      const branchCount = Math.max(message.branchCount ?? 1, known.length);
      const branchIndex = message.branchIndex ?? known.findIndex(node => node.id === message.id) + 1;
      return <article className={`asset-message asset-message-${message.role}`} key={message.id} data-name="assets.message" data-id={message.id}>
        <header><strong>{message.role === 'user' ? '我' : message.role === 'system' ? '系统提示' : 'AI'}</strong><span className={`asset-status ${detail?.status ?? 'complete'}`}>{statuses[detail?.status ?? 'complete']}</span>{message.locallyEdited && <span>本地编辑</span>}<time>{new Date(message.createdAt).toLocaleString()}</time></header>
        {message.role === 'assistant' && !!detail?.reasoning && <details key={`${message.id}:${settings.expandReasoning}`} className="asset-thinking" open={settings.expandReasoning || undefined}><summary>思考 · {detail.reasoningCharacters.toLocaleString()} 字符</summary><AssetMarkdown content={detail.reasoning} onAction={onAction} /></details>}
        {editing?.id === message.id ? <><textarea className="asset-message-editor" aria-label="编辑消息" value={editing.content} onChange={event => setEditing({ id: message.id, content: event.target.value })} /><div className="asset-actions"><Button variant="primary" onClick={() => onAction(async () => { await updateMessage(message.id, { content: editing.content }); setEditing(null); await onRefresh(); })}>保存本地编辑</Button><Button variant="outline" onClick={() => setEditing(null)}>取消</Button></div></> : <AssetMarkdown content={!message.locallyEdited && detail?.markdownContent ? detail.markdownContent : message.content} onAction={onAction} />}
        <div className="asset-message-footer"><div className="asset-actions"><Button variant="ghost" onClick={() => onAction(() => api.copyText(message.content))}>复制</Button><Button variant="ghost" onClick={() => setEditing({ id: message.id, content: message.content })}>编辑</Button><Button variant="ghost" onClick={() => onAction(() => onPrompt(message.content))}>存为提示词</Button><Button variant="ghost" onClick={() => setPendingDelete(message.id)}>删除</Button></div>
          {branchCount > 1 && <div className="asset-branch" aria-label="消息分支"><button aria-label="上一个分支" disabled={branchIndex <= 1} onClick={() => onAction(() => switchBranch(message, -1))}>‹</button><span>{branchIndex}/{branchCount}</span><button aria-label="下一个分支" disabled={branchIndex >= branchCount} onClick={() => onAction(() => switchBranch(message, 1))}>›</button>{known.length < branchCount && <span className="asset-branch-missing">部分分支尚未收纳</span>}</div>}
        </div>
        {!!detail?.revisions.length && <details className="asset-revisions"><summary>修订记录 · {detail.revisions.length}</summary>{detail.revisions.map((item, index) => <div key={item.id}><span>{new Date(item.capturedAt).toLocaleString()} · {statuses[item.status]}</span>{item.reasoning && <details><summary>当时的思考</summary><pre>{item.reasoning}</pre></details>}{settings.revisionDisplay === 'diff' ? <RevisionDifference before={item.content} after={detail.revisions[index + 1]?.content ?? message.content} /> : <pre>{item.content}</pre>}</div>)}</details>}
        {attachments.filter(item => item.messageId === message.id).map(file)}
      </article>;
    })}
    {attachments.filter(item => item.conversationId === conversation.id && !item.messageId).map(file)}
  </div>
  <ConfirmDialog open={!!pendingDelete} title={pendingDelete === 'conversation' ? '删除对话' : '删除消息'} message="仅删除本地内容并建立排除标记，避免自动收纳补回；原网页不受影响，已保存的资料原件保留。" variant="danger" onCancel={() => setPendingDelete(undefined)} onConfirm={() => onAction(async () => { if (pendingDelete === 'conversation') await api.deleteConversation(conversation.id); else if (pendingDelete) await api.deleteMessage(pendingDelete); setPendingDelete(undefined); await onRefresh(); })} />
  </>;
}
