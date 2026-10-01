import type { AiAssetsStore } from '../store/ai-assets-store.js'

export function exportAssetConversation(base: string, format: 'json' | 'md', id: string, assets: AiAssetsStore): string {
  const details = assets.details(id)
  const attachments = assets.attachments(id)
  if (format === 'json') {
    const data = JSON.parse(base)
    data.assetFormat = 1
    data.messages = data.messages.map((message: { id: string }) => ({ ...message, asset: details.find(item => item.messageId === message.id) }))
    data.attachments = attachments
    return JSON.stringify(data, null, 2)
  }
  const lines = [base, '## 资产记录', '', '资料引用不包含文件字节；完整原件请使用软件备份或单独导出。', '']
  for (const item of details) {
    lines.push(`### 消息 ${item.messageId}`, `状态：${item.status}`, `文本用量：输入 ${item.inputCharacters}，思考 ${item.reasoningCharacters}，输出 ${item.outputCharacters}`, '')
    if (item.reasoning) lines.push('#### 思考', '', item.reasoning, '')
    for (const revision of item.revisions) lines.push(`#### 修订 ${new Date(revision.capturedAt).toISOString()} (${revision.status})`, '', revision.content, '', revision.reasoning, '')
  }
  for (const item of attachments) lines.push(`### 资料：${item.name}`, `状态：${item.status} · ${item.direction}`, `消息：${item.messageId ?? '未关联'}`, `来源：${item.sourceUrl ?? item.sourceId}`, `SHA-256：${item.sha256 ?? '待获取'}`, '')
  return lines.join('\n')
}
