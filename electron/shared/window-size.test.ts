import { describe, expect, it } from 'vitest'
import {
  estimateTextWidth,
  calculateMainWindowMinWidth,
  UI_SCALE_CONFIG,
  type UiScale,
  type TopBarButtonGroup,
} from './window-size.js'

describe('estimateTextWidth', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTextWidth('', 15)).toBe(0)
  })

  it('should estimate ASCII character width', () => {
    // ASCII: fontSize * 0.6 per char
    const width = estimateTextWidth('abc', 15)
    expect(width).toBeCloseTo(3 * 15 * 0.6)
  })

  it('should estimate CJK character width', () => {
    // CJK: fontSize per char
    const width = estimateTextWidth('你好', 15)
    expect(width).toBeCloseTo(2 * 15)
  })

  it('should estimate mixed text width', () => {
    const width = estimateTextWidth('Hello你好', 15)
    // H,e,l,l,o = 5 * 15 * 0.6 = 45
    // 你,好 = 2 * 15 = 30
    expect(width).toBeCloseTo(45 + 30)
  })

  it('should handle different font sizes', () => {
    const widthSmall = estimateTextWidth('test', 13)
    const widthLarge = estimateTextWidth('test', 17)

    expect(widthLarge).toBeGreaterThan(widthSmall)
  })
})

describe('UI_SCALE_CONFIG', () => {
  it('should have configs for all scales', () => {
    expect(UI_SCALE_CONFIG.small).toBeDefined()
    expect(UI_SCALE_CONFIG.medium).toBeDefined()
    expect(UI_SCALE_CONFIG.large).toBeDefined()
  })

  it('should have larger icons for larger scales', () => {
    expect(UI_SCALE_CONFIG.large.icon).toBeGreaterThan(UI_SCALE_CONFIG.medium.icon)
    expect(UI_SCALE_CONFIG.medium.icon).toBeGreaterThan(UI_SCALE_CONFIG.small.icon)
  })

  it('should have larger text for larger scales', () => {
    expect(UI_SCALE_CONFIG.large.textBase).toBeGreaterThan(UI_SCALE_CONFIG.medium.textBase)
    expect(UI_SCALE_CONFIG.medium.textBase).toBeGreaterThan(UI_SCALE_CONFIG.small.textBase)
  })
})

describe('calculateMainWindowMinWidth', () => {
  it('should return a positive number', () => {
    const width = calculateMainWindowMinWidth('medium')
    expect(width).toBeGreaterThan(0)
  })

  it('should return larger width for larger scale', () => {
    const widthSmall = calculateMainWindowMinWidth('small')
    const widthMedium = calculateMainWindowMinWidth('medium')
    const widthLarge = calculateMainWindowMinWidth('large')

    expect(widthMedium).toBeGreaterThan(widthSmall)
    expect(widthLarge).toBeGreaterThan(widthMedium)
  })

  it('should return smaller width with fewer visible buttons', () => {
    const widthAll = calculateMainWindowMinWidth('medium')
    const widthMinimal = calculateMainWindowMinWidth('medium', [])

    expect(widthAll).toBeGreaterThan(widthMinimal)
  })

  it('should return larger width with longer title', () => {
    const widthShort = calculateMainWindowMinWidth('medium', undefined, 'Test')
    const widthLong = calculateMainWindowMinWidth('medium', undefined, '这是一个很长的标题文本')

    expect(widthLong).toBeGreaterThan(widthShort)
  })

  it('should round up to nearest 10', () => {
    const width = calculateMainWindowMinWidth('medium')
    expect(width % 10).toBe(0)
  })

  it('should handle all buttons visible', () => {
    const buttons: TopBarButtonGroup[] = ['uaToggle', 'navBack', 'navForward', 'navHome', 'themeToggle', 'pinToggle']
    const width = calculateMainWindowMinWidth('medium', buttons)

    expect(width).toBeGreaterThan(0)
  })

  it('should handle no optional buttons', () => {
    const width = calculateMainWindowMinWidth('medium', [])

    expect(width).toBeGreaterThan(0)
  })
})
