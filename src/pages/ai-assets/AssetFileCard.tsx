import { Button } from '../../components/ui';
import type { AssetAttachment } from '../../../electron/shared/ai-assets.types';
import { requireElectron } from '../../lib/electron-api/core';

const statuses = { pending: '待获取', saved: '已收纳', reused: '复用原件', failed: '获取失败' };
export default function AssetFileCard({ item, onConversation, onAction }: {
  item: AssetAttachment; onConversation: (id: string) => void;
  onAction: (operation: () => Promise<void>) => void;
}) {
  const api = requireElectron().aiAssets;
  return <article className="asset-file" data-name="assets.file" data-id={item.id}>
    <div><strong>{item.name}</strong><span className={`asset-status ${item.status}`}>{statuses[item.status]}</span></div>
    <p>{item.direction === 'input' ? '用户发送' : 'AI 返回'} · {item.size === undefined ? '大小待确认' : `${item.size.toLocaleString()} 字节`}</p>
    {item.sha256 && <code title={item.sha256}>SHA-256 {item.sha256.slice(0, 16)}…</code>}
    {item.sourceUrl && <p className="asset-origin" title={item.sourceUrl}>来源：{item.sourceUrl}</p>}
    {item.error && <p role="status" className="asset-error">{item.error}</p>}
    <div className="asset-actions"><Button variant="outline" onClick={() => onConversation(item.conversationId)}>查看对话</Button>
      {['saved', 'reused'].includes(item.status) ? <Button variant="outline" onClick={() => onAction(async () => {
        const result = await api.openAttachment(item.id); if (!result.ok) throw new Error(result.error);
      })}>定位原件</Button> : <Button variant="outline" onClick={() => onAction(async () => {
        const result = await api.retryAttachment(item.id); if (!result.ok) throw new Error(result.error);
      })}>重试收纳</Button>}
      {item.sha256 && <Button variant="outline" onClick={() => onAction(async () => {
        const result = await api.exportAttachment(item.id); if (!result.ok && !result.canceled) throw new Error(result.error);
      })}>导出原件</Button>}
    </div>
  </article>;
}
