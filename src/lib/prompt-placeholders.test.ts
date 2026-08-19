import { describe, expect, it } from 'vitest'
import { composeFinalText, type PlaceholderContext } from './prompt-placeholders.js'

describe('composeFinalText', () => {
  it('should replace {{body}} placeholder', () => {
    const template = { content: '翻译成英文：{{body}}' }
    const context: PlaceholderContext = { body: '你好' }

    expect(composeFinalText(template, context)).toBe('翻译成英文：你好')
  })

  it('should replace multiple {{body}} placeholders', () => {
    const template = { content: '{{body}} 和 {{body}}' }
    const context: PlaceholderContext = { body: '测试' }

    expect(composeFinalText(template, context)).toBe('测试 和 测试')
  })

  it('should return content unchanged when no placeholders', () => {
    const template = { content: '普通文本' }
    const context: PlaceholderContext = { body: '你好' }

    expect(composeFinalText(template, context)).toBe('普通文本')
  })

  it('should handle empty body', () => {
    const template = { content: '前缀 {{body}} 后缀' }
    const context: PlaceholderContext = { body: '' }

    expect(composeFinalText(template, context)).toBe('前缀  后缀')
  })

  it('should handle undefined body', () => {
    const template = { content: '前缀 {{body}} 后缀' }
    const context: PlaceholderContext = { body: undefined as any }

    expect(composeFinalText(template, context)).toBe('前缀  后缀')
  })

  it('should handle empty content', () => {
    const template = { content: '' }
    const context: PlaceholderContext = { body: '你好' }

    expect(composeFinalText(template, context)).toBe('')
  })

  it('should handle undefined content', () => {
    const template = { content: undefined }
    const context: PlaceholderContext = { body: '你好' }

    expect(composeFinalText(template as any, context)).toBe('')
  })

  it('should handle special characters in body', () => {
    const template = { content: '内容：{{body}}' }
    const context: PlaceholderContext = { body: '<script>alert("xss")</script>' }

    expect(composeFinalText(template, context)).toBe('内容：<script>alert("xss")</script>')
  })
})
