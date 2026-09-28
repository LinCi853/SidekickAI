import { describe, expect, it } from 'vitest'
import { mergeDuplicateMessages } from './message-merge'
import type { ChatMessage } from './electron-api'

function msg(id: string, role: string, content: string): ChatMessage {
  return { id, conversationId: 'c1', role: role as ChatMessage['role'], content, createdAt: 0 }
}

describe('mergeDuplicateMessages（历史消息展示层去重）', () => {
  it('同 role + 同 content 的消息保留首条并累计 dupCount', () => {
    const merged = mergeDuplicateMessages([
      msg('1', 'user', '你好'),
      msg('2', 'user', '你好'),
      msg('3', 'user', '你好'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].msg.id).toBe('1')
    expect(merged[0].dupCount).toBe(2)
  })

  it('不同 role 的相同内容不合并', () => {
    const merged = mergeDuplicateMessages([msg('1', 'user', '同文'), msg('2', 'assistant', '同文')])
    expect(merged).toHaveLength(2)
    expect(merged.every(m => m.dupCount === 0)).toBe(true)
  })

  it('不同内容不合并且保持顺序', () => {
    const merged = mergeDuplicateMessages([msg('1', 'user', 'A'), msg('2', 'user', 'B'), msg('3', 'user', 'A')])
    expect(merged.map(m => m.msg.id)).toEqual(['1', '2'])
    expect(merged[0].dupCount).toBe(1)
    expect(merged[1].dupCount).toBe(0)
  })

  it('空列表返回空数组', () => {
    expect(mergeDuplicateMessages([])).toEqual([])
  })
})
