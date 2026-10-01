import { describe, expect, it } from 'vitest'
import { addedCharacters, countCharacters, promptWeight } from './text-usage'

describe('local text usage', () => {
  it('counts Unicode code points, whitespace, punctuation and code', () => {
    expect(countCharacters('中 A😀\n;')).toBe(6)
    expect(countCharacters('')).toBe(0)
  })
  it('counts only newly received characters, preserving withdrawn usage', () => {
    expect(addedCharacters('答', '答案')).toBe(1)
    expect(addedCharacters('答案', '')).toBe(0)
    expect(addedCharacters('abc tail', 'adc tail')).toBe(1)
    expect(addedCharacters('😀', '😀中')).toBe(1)
    expect(addedCharacters('答案', '答案')).toBe(0)
  })
  it('ranks instructions and repeated prompts locally', () => {
    expect(promptWeight('请总结以下资料：{{body}}', 1)).toBe(5)
    expect(promptWeight('repeat', 3)).toBe(2)
    expect(promptWeight('hello', 1)).toBe(0)
  })
})
