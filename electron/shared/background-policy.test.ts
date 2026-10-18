import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_RELEASE_DELAY_MS,
  BACKGROUND_RELEASE_DELAY_DEFAULT_MS,
  browserWindowRetirementSeconds,
  backgroundReleaseDelayMs,
  windowRetirementSeconds,
} from './background-policy.js'

describe('background policy low-memory tiers', () => {
  it('keeps current retirement seconds in low memory mode and doubles them by default', () => {
    expect(windowRetirementSeconds('history', true)).toBe(30)
    expect(windowRetirementSeconds('history', false)).toBe(60)
    expect(windowRetirementSeconds('settings', true)).toBe(60)
    expect(windowRetirementSeconds('settings', false)).toBe(120)
    expect(windowRetirementSeconds('main', true)).toBe(180)
    expect(windowRetirementSeconds('main', false)).toBe(360)
    expect(windowRetirementSeconds('chat-1', true)).toBe(300)
    expect(windowRetirementSeconds('chat-1', false)).toBe(600)
    expect(windowRetirementSeconds('browser-1', true)).toBe(600)
    expect(windowRetirementSeconds('browser-1', false)).toBe(1200)
    expect(windowRetirementSeconds('standalone-1', true)).toBe(600)
    expect(windowRetirementSeconds('ai-app-2', true)).toBe(600)
    expect(windowRetirementSeconds('ai-app-editor-1', true)).toBe(60)
  })

  it('scales browser retirement the same way', () => {
    expect(browserWindowRetirementSeconds(true)).toBe(600)
    expect(browserWindowRetirementSeconds(false)).toBe(1200)
  })

  it('halves pure background release delay in low memory mode', () => {
    expect(BACKGROUND_RELEASE_DELAY_MS).toBe(15 * 60_000)
    expect(BACKGROUND_RELEASE_DELAY_DEFAULT_MS).toBe(30 * 60_000)
    expect(backgroundReleaseDelayMs(true)).toBe(15 * 60_000)
    expect(backgroundReleaseDelayMs(false)).toBe(30 * 60_000)
    expect(backgroundReleaseDelayMs(true) * 2).toBe(backgroundReleaseDelayMs(false))
  })
})
