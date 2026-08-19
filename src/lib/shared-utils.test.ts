import { describe, expect, it, vi } from 'vitest'
import {
  findProfilesByPlatform,
  findProfileByPlatform,
  findAiAppProfiles,
} from './shared-utils.js'

// Note: isTypingTarget requires HTMLElement which is only available in browser environment
// In vitest (node), we skip testing it directly

describe('findProfilesByPlatform', () => {
  const platform = { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' } as any

  it('should find profiles by platform id', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 0 },
      { id: '2', isAIPlatform: true, aiPlatformId: 'claude', order: 1 },
    ] as any[]

    const result = findProfilesByPlatform(platform, profiles)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('should find profiles by platform url', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformUrl: 'https://chatgpt.com', order: 0 },
      { id: '2', isAIPlatform: true, aiPlatformUrl: 'https://claude.ai', order: 1 },
    ] as any[]

    const result = findProfilesByPlatform(platform, profiles)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('should return multiple profiles for same platform', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 1 },
      { id: '2', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 0 },
      { id: '3', isAIPlatform: true, aiPlatformId: 'claude', order: 2 },
    ] as any[]

    const result = findProfilesByPlatform(platform, profiles)
    expect(result).toHaveLength(2)
    // Should be sorted by order
    expect(result[0].id).toBe('2')
    expect(result[1].id).toBe('1')
  })

  it('should return empty array when no match', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'claude', order: 0 },
    ] as any[]

    const result = findProfilesByPlatform(platform, profiles)
    expect(result).toHaveLength(0)
  })

  it('should exclude non-AI profiles', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 0 },
      { id: '2', isAIPlatform: false, aiPlatformId: 'chatgpt', order: 1 },
    ] as any[]

    const result = findProfilesByPlatform(platform, profiles)
    expect(result).toHaveLength(1)
  })
})

describe('findProfileByPlatform', () => {
  const platform = { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' } as any

  it('should return first matching profile', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 1 },
      { id: '2', isAIPlatform: true, aiPlatformId: 'chatgpt', order: 0 },
    ] as any[]

    const result = findProfileByPlatform(platform, profiles)
    expect(result?.id).toBe('2') // sorted by order
  })

  it('should return undefined when no match', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, aiPlatformId: 'claude', order: 0 },
    ] as any[]

    const result = findProfileByPlatform(platform, profiles)
    expect(result).toBeUndefined()
  })
})

describe('findAiAppProfiles', () => {
  it('should return all AI platform profiles sorted by order', () => {
    const profiles = [
      { id: '1', isAIPlatform: true, order: 2 },
      { id: '2', isAIPlatform: false, order: 0 },
      { id: '3', isAIPlatform: true, order: 1 },
    ] as any[]

    const result = findAiAppProfiles(profiles)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('3')
    expect(result[1].id).toBe('1')
  })

  it('should return empty array when no AI profiles', () => {
    const profiles = [
      { id: '1', isAIPlatform: false, order: 0 },
    ] as any[]

    const result = findAiAppProfiles(profiles)
    expect(result).toHaveLength(0)
  })

  it('should handle missing order field', () => {
    const profiles = [
      { id: '1', isAIPlatform: true },
      { id: '2', isAIPlatform: true, order: 1 },
    ] as any[]

    const result = findAiAppProfiles(profiles)
    expect(result).toHaveLength(2)
  })
})
