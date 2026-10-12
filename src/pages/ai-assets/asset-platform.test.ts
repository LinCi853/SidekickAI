import { describe, expect, it } from 'vitest'
import { conversationAiLabel, conversationPlatform, displayConversationTitle } from './asset-platform'
import type { Conversation } from '../../lib/electron-api'

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'a', title: '', sourceId: 's', sourceType: 'webview', createdAt: 1, updatedAt: 1, ...overrides,
})

describe('conversationPlatform', () => {
  it('maps known hosts to platform names including subdomains', () => {
    expect(conversationPlatform(conversation({ url: 'https://chat.deepseek.com/a/b' }))).toBe('DeepSeek')
    expect(conversationPlatform(conversation({ url: 'https://aistudio.xiaomimimo.com/' }))).toBe('MiMo')
    expect(conversationPlatform(conversation({ url: 'https://www.doubao.com/chat' }))).toBe('豆包')
    expect(conversationPlatform(conversation({ url: 'https://kimi.moonshot.cn' }))).toBe('Kimi')
  })

  it('falls back to the hostname for unknown sites and to API or web markers without a url', () => {
    expect(conversationPlatform(conversation({ url: 'https://example.org/chat' }))).toBe('example.org')
    expect(conversationPlatform(conversation({ url: 'https://www.example.org/chat' }))).toBe('example.org')
    expect(conversationPlatform(conversation({ sourceType: 'api', url: 'https://api.example.org' }))).toBe('API')
    expect(conversationPlatform(conversation({ url: undefined }))).toBe('网页')
    expect(conversationPlatform(conversation({ url: '::not a url::' }))).toBe('网页')
  })
})

describe('displayConversationTitle', () => {
  it('strips a trailing platform name that duplicates the conversation source', () => {
    expect(displayConversationTitle(conversation({ title: 'MiMo实时与批量推理 - DeepSeek', url: 'https://chat.deepseek.com/a' }))).toBe('MiMo实时与批量推理')
    expect(displayConversationTitle(conversation({ title: '工百窗优化建议 ｜ DeepSeek', url: 'https://chat.deepseek.com/a' }))).toBe('工百窗优化建议')
  })

  it('keeps titles without a duplicated platform suffix and never empties the title', () => {
    expect(displayConversationTitle(conversation({ title: 'DeepSeek - 探索未至之境', url: 'https://chat.deepseek.com/a' }))).toBe('DeepSeek - 探索未至之境')
    expect(displayConversationTitle(conversation({ title: 'Xiaomi MiMo Studio', url: 'https://aistudio.xiaomimimo.com/' }))).toBe('Xiaomi MiMo Studio')
    expect(displayConversationTitle(conversation({ title: ' - DeepSeek', url: 'https://chat.deepseek.com/a' }))).toBe(' - DeepSeek')
    expect(displayConversationTitle(conversation({ title: '', url: 'https://chat.deepseek.com/a' }))).toBe('未命名对话')
    expect(displayConversationTitle(conversation({ title: '本地笔记', url: undefined }))).toBe('本地笔记')
  })
})

describe('conversationAiLabel', () => {
  it('names the owning AI application and falls back for unknown sources', () => {
    expect(conversationAiLabel(conversation({ url: 'https://chatglm.cn/main/alltoolsdetail?cid=one' }))).toBe('智谱清言')
    expect(conversationAiLabel(conversation({ url: 'https://chat.deepseek.com/a' }))).toBe('DeepSeek')
    expect(conversationAiLabel(conversation({ sourceType: 'api' }))).toBe('API')
    expect(conversationAiLabel(conversation({ url: undefined }))).toBe('AI应用')
    expect(conversationAiLabel(conversation({ url: 'https://example.org/chat' }))).toBe('example.org')
  })
})
