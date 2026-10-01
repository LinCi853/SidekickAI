import { useEffect, useState } from 'react';
import { Button, EmptyState } from '../../components/ui';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { listMessages, deleteConversation, exportConversation, updateMessage } from '../../lib/electron-api';
import { requireElectron } from '../../lib/electron-api/core';
import type { ChatMessage, Conversation } from '../../lib/electron-api';
import type { AssetAttachment, AssetMessageDetail } from '../../../electron/shared/ai-assets.types';
import AssetFileCard from './AssetFileCard';

const statuses: Record<string, string> = { streaming: '接收中', complete: '已记录', withdrawn: '已撤回，原文保留', retained: '页面已隐藏，原文保留', stopped: '已停止', failed: '响应中断' };
export default function AssetConversation({ conversation, revision, attachments, onAction, onRefresh, onPrompt, onConversation }: {
  conversation?: Conversation; revision: number; attachments: AssetAttachment[];
  onAction: (operation: () => Promise<void>) => void; onRefresh: () => Promise<void>;
  onPrompt: (content: string) => Promise<void>; onConversation: (id: string) => void;
}) {
  const api = requireElectron().aiAssets;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [details, setDetails] = useState<AssetMessageDetail[]>([]);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  useEffect(() => {
    let active = true;
    setError('');
    if (!conversation) { setMessages([]); setDetails([]); return; }
    void Promise.all([listMessages(conversation.id), api.details(conversation.id)]).then(([list, states]) => {
      if (active) { setMessages(list); setDetails(states); }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [api, conversation?.id, revision]);
  useEffect(() => { setEditing(null); }, [conversation?.id]);
  if (!conversation) return <EmptyState message="选择对话查看完整记录" />;
  const file = (item: AssetAttachment) => <AssetFileCard key={item.id} item={item} onAction={onAction} onConversation={onConversation} />;
  return <><div className="asset-detail-heading"><h2>{conversation.title}</h2><div className="asset-actions">
    {(['md', 'json'] as const).map(format => <Button key={format} variant="outline" onClick={() => onAction(async () => {
      const result = await exportConversation(conversation.id, format);
      if (!result.ok && !result.canceled) throw new Error('导出失败');
    })}>导出 {format.toUpperCase()}</Button>)}
    <Button variant="danger" onClick={() => setPendingDelete(true)}>删除对话</Button>
  </div></div>
  {error && <p className="asset-error" role="alert">{error}</p>}
  {!messages.length && <EmptyState message="尚未取得对话文本，等待交流内容出现" />}
  {messages.map(message => {
    const detail = details.find(item => item.messageId === message.id);
    return <article className="asset-message" key={message.id} data-name="assets.message" data-id={message.id}>
      <header><strong>{message.role === 'user' ? '输入' : message.role === 'system' ? '系统提示' : '输出'}</strong>
        <span className="asset-status">{statuses[detail?.status ?? 'complete']}</span><span>{new Date(message.createdAt).toLocaleString()}</span></header>
      {message.role === 'assistant' && <details className="asset-thinking"><summary>思考 · {detail?.reasoning ? `${detail.reasoningCharacters} 字符` : '未提供'}</summary>
        {detail?.reasoning && <pre>{detail.reasoning}</pre>}</details>}
      {editing?.id === message.id ? <><textarea className="asset-message-editor" aria-label="编辑消息" value={editing.content}
        onChange={event => setEditing({ id: message.id, content: event.target.value })} /><div className="asset-actions">
        <Button variant="primary" onClick={() => onAction(async () => {
          await updateMessage(message.id, { content: editing.content }); setEditing(null); await onRefresh();
        })}>保存修订</Button><Button variant="outline" onClick={() => setEditing(null)}>取消</Button></div></> : <pre>{message.content}</pre>}
      <div className="asset-actions">
        <Button variant="ghost" onClick={() => onAction(() => navigator.clipboard.writeText(message.content))}>复制</Button>
        <Button variant="ghost" onClick={() => setEditing({ id: message.id, content: message.content })}>编辑</Button>
        {message.role === 'user' && <Button variant="outline" onClick={() => onAction(() => onPrompt(message.content))}>存为提示词</Button>}
      </div>
      {!!detail?.revisions.length && <details className="asset-revisions"><summary>修订记录 · {detail.revisions.length}</summary>
        {detail.revisions.map(item => <div key={item.id}><span>{new Date(item.capturedAt).toLocaleString()} · {statuses[item.status]}</span>
          {item.reasoning && <details><summary>思考</summary><pre>{item.reasoning}</pre></details>}<pre>{item.content}</pre></div>)}
      </details>}
      {attachments.filter(item => item.messageId === message.id).map(file)}
    </article>;
  })}
  {attachments.filter(item => item.conversationId === conversation.id && !item.messageId).map(file)}
  <ConfirmDialog open={pendingDelete} title="删除对话" message="将删除这段对话及其资产引用，已保存的原件保留。" variant="danger"
    onCancel={() => setPendingDelete(false)} onConfirm={() => onAction(async () => {
      await deleteConversation(conversation.id); setPendingDelete(false); await onRefresh();
    })} />
  </>;
}
