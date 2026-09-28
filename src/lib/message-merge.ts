// src/lib/message-merge.ts —— 历史消息展示层去重合并
//
// 存储层已用 content_hash + INSERT OR IGNORE 防止重复入库；此处仅做视觉合并：
// 同 role + 同 content 的消息仅保留首条并标注重复次数，重复条目折叠不渲染正文。

import type { ChatMessage } from './electron-api';

export interface MergedMessage {
  msg: ChatMessage;
  /** 与首条完全相同的后续消息数量（展示为「重复 ×N」） */
  dupCount: number;
}

export function mergeDuplicateMessages(messages: ChatMessage[]): MergedMessage[] {
  const result: MergedMessage[] = [];
  const seen = new Map<string, number>(); // key(role\0content) → result 索引
  for (const m of messages) {
    const key = `${m.role}\u0000${m.content}`;
    const idx = seen.get(key);
    if (idx !== undefined) {
      result[idx].dupCount += 1;
    } else {
      seen.set(key, result.length);
      result.push({ msg: m, dupCount: 0 });
    }
  }
  return result;
}
