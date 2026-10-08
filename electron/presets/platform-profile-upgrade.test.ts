import { describe, expect, it } from 'vitest'
import type { Profile } from '../shared/types'
import { AI_PLATFORMS } from './ai-platforms'
import { hasQianwenProfile, upgradeAIPlatformProfile } from './platform-profile-upgrade'

const profile = (patch: Partial<Profile>) => ({ id: 'existing', name: 'My profile', isAIPlatform: true, ...patch }) as Profile
describe('AI platform profile upgrade', () => {
  it('replaces old default accents while preserving profile identity and custom colors', () => {
    const existing = profile({ aiPlatformId: 'doubao', aiThemeColor: '#3370FF' })
    expect(upgradeAIPlatformProfile(existing)).toEqual({ ...existing, aiThemeColor: '#d64f68' })
    const custom = profile({ aiPlatformId: 'doubao', aiThemeColor: '#aBc' })
    expect(upgradeAIPlatformProfile(custom)).toBe(custom)
    expect(upgradeAIPlatformProfile(profile({ isAIPlatform: false, aiThemeColor: '#3370ff' })).aiThemeColor).toBe('#3370ff')
  })
  it('moves only the old MiMo default homepage to its chat entrance', () => {
    const existing = profile({ aiPlatformId: 'mimo', aiPlatformUrl: 'https://mimo.xiaomi.com/' })
    expect(upgradeAIPlatformProfile(existing)).toEqual({ ...existing, aiPlatformUrl: 'https://aistudio.xiaomimimo.com/#/c' })
    expect(upgradeAIPlatformProfile(profile({ aiPlatformUrl: 'https://mimo.xiaomi.com' })).aiPlatformUrl).toBe('https://aistudio.xiaomimimo.com/#/c')
    const custom = profile({ aiPlatformId: 'mimo', aiPlatformUrl: 'https://example.com/my-chat' })
    expect(upgradeAIPlatformProfile(custom)).toBe(custom)
  })
  it('uses the declared platform before a custom URL', () => {
    const custom = profile({ aiPlatformId: 'deepseek', aiPlatformUrl: 'https://www.doubao.com/chat', aiThemeColor: '#3370ff' })
    expect(upgradeAIPlatformProfile(custom)).toBe(custom)
    const unknown = { ...custom, aiPlatformId: 'custom' }
    expect(upgradeAIPlatformProfile(unknown)).toBe(unknown)
  })
  it('recognizes existing custom Qianwen configurations without relying on names', () => {
    expect(hasQianwenProfile([profile({ name: 'Renamed', aiPlatformUrl: 'https://www.qianwen.com/chat/one' })])).toBe(true)
    expect(hasQianwenProfile([profile({ name: 'Qianwen', aiPlatformUrl: 'https://example.com' })])).toBe(false)
  })
  it('exposes Qianwen input and navigation settings with varied domestic accents', () => {
    const qianwen = AI_PLATFORMS.find(platform => platform.id === 'qianwen')!
    expect(qianwen.url).toBe('https://www.qianwen.com/')
    expect(qianwen.inputSelector).toContain('data-slate-editor')
    expect(qianwen.sendSelector).toContain('data-session-switch-target')
    expect(qianwen.allowedOrigins).toContain('https://www.qianwen.com/')
    expect(new Set(AI_PLATFORMS.filter(platform => platform.region === 'cn').map(platform => platform.themeColor)).size).toBe(7)
  })
})
