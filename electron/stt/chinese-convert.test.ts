import { describe, expect, it } from 'vitest'
import { convertTraditionalToSimplified } from './chinese-convert'
describe('traditional-to-simplified conversion', () => {
  it('preserves empty and non-Chinese transcription', () => {
    expect(convertTraditionalToSimplified('')).toBe('')
    expect(convertTraditionalToSimplified('hello 123')).toBe('hello 123')
  })
  it('converts traditional characters and Taiwan terminology with the directional dictionary', () => {
    expect(convertTraditionalToSimplified('測試')).toBe('测试')
    expect(convertTraditionalToSimplified('軟體/檔案/記憶體')).toBe('软件/文件/内存')
    expect(convertTraditionalToSimplified('漢語 hello')).toBe('汉语 hello')
  })
})
