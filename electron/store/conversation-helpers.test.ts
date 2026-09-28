import { describe, expect, it } from 'vitest'
import {
  assertObject,
  computeContentHash,
  jaccardSimilarity,
  parseJsonSafe,
  rowToConversation,
  rowToMessage,
  shouldFilterShortMessage,
  type ConversationRow,
  type MessageRow,
} from './conversation-helpers'

const conversationRow: ConversationRow = {
  id: 'c1', source_id: 'p1', source_type: 'webview', title: '标题',
  created_at: 100, updated_at: 200, url: null,
}
const messageRow: MessageRow = {
  id: 'm1', conversation_id: 'c1', role: 'user', content: '内容',
  tokens: null, created_at: 100, content_hash: 'h', auto_grabbed: 1,
}

describe('conversation-helpers（行映射与纯工具）', () => {
  it('rowToConversation 映射下划线列为驼峰，null url 转 undefined', () => {
    expect(rowToConversation(conversationRow)).toEqual({
      id: 'c1', sourceId: 'p1', sourceType: 'webview', title: '标题',
      createdAt: 100, updatedAt: 200, url: undefined,
    })
  })

  it('rowToMessage 映射 auto_grabbed 数值为布尔', () => {
    expect(rowToMessage(messageRow)).toMatchObject({ id: 'm1', autoGrabbed: true, tokens: undefined })
    expect(rowToMessage({ ...messageRow, auto_grabbed: 0 }).autoGrabbed).toBe(false)
    expect(rowToMessage({ ...messageRow, auto_grabbed: null }).autoGrabbed).toBe(false)
  })

  it('computeContentHash 对相同输入稳定、不同输入不同', () => {
    expect(computeContentHash('c1', 'user', '你好')).toBe(computeContentHash('c1', 'user', '你好'))
    expect(computeContentHash('c1', 'user', '你好')).not.toBe(computeContentHash('c1', 'user', '再见'))
    expect(computeContentHash('c1', 'user', '你好')).not.toBe(computeContentHash('c2', 'user', '你好'))
  })

  it('shouldFilterShortMessage 过滤空白/过短/纯标点文本', () => {
    expect(shouldFilterShortMessage('')).toBe(true)
    expect(shouldFilterShortMessage('   ')).toBe(true)
    expect(shouldFilterShortMessage('短')).toBe(true)
    expect(shouldFilterShortMessage('。。。？！')).toBe(true)
    expect(shouldFilterShortMessage('这是一段足够长的正常文本内容哦')).toBe(false)
  })

  it('jaccardSimilarity：完全相同为 1、无交集为 0、部分相似介于其间', () => {
    expect(jaccardSimilarity('abcd', 'abcd')).toBe(1)
    expect(jaccardSimilarity('abcd', 'efgh')).toBe(0)
    const partial = jaccardSimilarity('abcd', 'abce')
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(1)
    expect(jaccardSimilarity('', '')).toBe(1)
  })

  it('parseJsonSafe 解析合法 JSON、非法输入抛业务错误', () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 })
    expect(() => parseJsonSafe('not json')).toThrow('JSON 解析失败')
  })

  it('assertObject 接受普通对象、拒绝 null 与数组', () => {
    expect(() => assertObject({ a: 1 })).not.toThrow()
    expect(() => assertObject(null)).toThrow('导入数据不是合法对象')
    expect(() => assertObject([1])).toThrow('导入数据不是合法对象')
  })
})
