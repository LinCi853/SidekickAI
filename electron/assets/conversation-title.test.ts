import { describe, expect, it } from 'vitest'
import { isPlatformDefaultTitle, normalizeWebHostname, titleFromMessageContent } from './conversation-title'

describe('platform default titles', () => {
  it('treats the ChatGLM site title as a non-conversation name', () => {
    expect(isPlatformDefaultTitle('chatglm.cn', '智谱清言')).toBe(true)
    expect(isPlatformDefaultTitle('www.chatglm.cn', '智谱清言 - 全能AI助手')).toBe(true)
    expect(isPlatformDefaultTitle('www.chatglm.cn', '智谱清言｜智能对话')).toBe(true)
    expect(isPlatformDefaultTitle('chatglm.cn', '口语对白镜头头出海提纯 - 智谱清言')).toBe(false)
    expect(isPlatformDefaultTitle('chatglm.cn', '')).toBe(true)
  })

  it('keeps real conversation titles on mapped platforms', () => {
    expect(isPlatformDefaultTitle('chat.deepseek.com', '部署方案讨论')).toBe(false)
    expect(isPlatformDefaultTitle('chat.deepseek.com', '部署方案讨论 - DeepSeek')).toBe(false)
    expect(isPlatformDefaultTitle('kimi.moonshot.cn', 'Kimi')).toBe(true)
    expect(isPlatformDefaultTitle('doubao.com', '豆包')).toBe(true)
  })

  it('leaves unmapped hosts alone except for empty titles', () => {
    expect(isPlatformDefaultTitle('example.com', '智谱清言')).toBe(false)
    expect(isPlatformDefaultTitle('example.com', '')).toBe(true)
  })

  it('normalizes www and case for hostname lookups', () => {
    expect(normalizeWebHostname('WWW.ChatGLM.CN')).toBe('chatglm.cn')
    expect(isPlatformDefaultTitle('WWW.ChatGLM.CN', '智谱清言')).toBe(true)
  })
})

describe('titles derived from the first user message', () => {
  it('takes the first non-empty line and strips markdown prefixes', () => {
    expect(titleFromMessageContent('口语对白镜头头出海提纯\n第二行')).toBe('口语对白镜头头出海提纯')
    expect(titleFromMessageContent('\n  > 引用开头才是首行')).toBe('引用开头才是首行')
    expect(titleFromMessageContent('### 标题行')).toBe('标题行')
    expect(titleFromMessageContent('- 列表项开头')).toBe('列表项开头')
    expect(titleFromMessageContent('1. 有序列表开头')).toBe('有序列表开头')
  })

  it('caps the derived title length and handles empty content', () => {
    expect(Array.from(titleFromMessageContent('长'.repeat(80))).length).toBe(48)
    expect(titleFromMessageContent('   \n \n')).toBe('')
    expect(titleFromMessageContent('')).toBe('')
  })
})
