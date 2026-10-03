import { Download, File, FileImage, FileText, FolderOpen, MessageSquare, RotateCw } from 'lucide-react';
import { IconButton } from '../../components/ui';
import type { AssetAttachment } from '../../../electron/shared/ai-assets.types';
import { requireElectron } from '../../lib/electron-api/core';

const statuses = { pending: '待获取', saved: '已收纳', reused: '复用原件', failed: '获取失败' };
function fileSize(size?: number) {
  if (size === undefined) return '大小待确认';
  if (size < 1024) return `${size.toLocaleString()} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function AssetFileCard({ item, onConversation, onAction, showConversation = true }: {
  item: AssetAttachment; onConversation: (id: string, target?: { messageId?: string; attachmentId?: string }) => void;
  onAction: (operation: () => Promise<void>) => void;
  showConversation?: boolean;
}) {
  const api = requireElectron().aiAssets;
  const Icon = item.mimeType.startsWith('image/') ? FileImage : item.mimeType.startsWith('text/') ? FileText : File;
  return <article className={`asset-file asset-file-${item.status}`} data-name="assets.file" data-id={item.id}>
    <div className="asset-file-heading"><Icon size={20} aria-hidden="true" /><div><strong title={item.name}>{item.name}</strong>
      <span className="asset-file-metadata"><span title={item.mimeType}>{item.mimeType || '未知类型'}</span><span title={item.size === undefined ? undefined : `${item.size.toLocaleString()} 字节`}>{fileSize(item.size)}</span></span></div></div>
    <div className="asset-file-status"><span className={`asset-status ${item.status}`}>{statuses[item.status]}</span><span>{item.direction === 'input' ? '用户发送' : 'AI 返回'}</span></div>
    <div className="asset-file-actions">
      {showConversation && <IconButton className="asset-icon-button" aria-label="查看来源对话" onClick={() => onConversation(item.conversationId, { messageId: item.messageId, attachmentId: item.id })}><MessageSquare size={16} /></IconButton>}
      {['saved', 'reused'].includes(item.status) ? <IconButton className="asset-icon-button" aria-label="定位原件" onClick={() => onAction(async () => {
        const result = await api.openAttachment(item.id); if (!result.ok) throw new Error(result.error);
      })}><FolderOpen size={16} /></IconButton> : <IconButton className="asset-icon-button" aria-label="重试收纳" onClick={() => onAction(async () => {
        const result = await api.retryAttachment(item.id); if (!result.ok) throw new Error(result.error);
      })}><RotateCw size={16} /></IconButton>}
      {item.sha256 && <IconButton className="asset-icon-button" aria-label="导出原件" onClick={() => onAction(async () => {
        const result = await api.exportAttachment(item.id); if (!result.ok && !result.canceled) throw new Error(result.error);
      })}><Download size={16} /></IconButton>}
    </div>
    {(item.sha256 || item.sourceUrl || item.error) && <details className="asset-file-details"><summary>详细信息{item.error ? ' · 获取失败' : ''}</summary>
      {item.sourceUrl && <p className="asset-origin">来源：{item.sourceUrl}</p>}
      {item.sha256 && <p><code>SHA-256 {item.sha256}</code></p>}
      {item.error && <p role="status" className="asset-error">{item.error}</p>}
    </details>}
  </article>;
}
