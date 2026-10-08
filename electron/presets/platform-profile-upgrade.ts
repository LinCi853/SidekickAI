import type { Profile } from '../shared/types.js'
import { AI_PLATFORMS } from './ai-platforms.js'

const previousColors: Record<string, string> = { doubao: '#3370ff', chatglm: '#316cfc', yiyan: '#1c7fff' }

export function upgradeAIPlatformProfile(profile: Profile): Profile {
  if (!profile.isAIPlatform) return profile
  const oldMimoUrl = /^https:\/\/mimo\.xiaomi\.com\/?$/.test(profile.aiPlatformUrl ?? '')
  const platform = profile.aiPlatformId
    ? AI_PLATFORMS.find(platform => platform.id === profile.aiPlatformId)
    : AI_PLATFORMS.find(platform => platform.url === profile.aiPlatformUrl || (oldMimoUrl && platform.id === 'mimo'))
  if (!platform) return profile
  const patch: Partial<Profile> = {}
  const previousColor = previousColors[platform.id]
  if (previousColor && profile.aiThemeColor?.toLowerCase() === previousColor) patch.aiThemeColor = platform.themeColor
  if (platform.id === 'mimo' && oldMimoUrl) patch.aiPlatformUrl = platform.url
  return Object.keys(patch).length ? { ...profile, ...patch } : profile
}

export function hasQianwenProfile(profiles: Profile[]): boolean {
  return profiles.some(profile => {
    if (!profile.isAIPlatform) return false
    if (profile.aiPlatformId === 'qianwen') return true
    try { return ['qianwen.com', 'www.qianwen.com'].includes(new URL(profile.aiPlatformUrl ?? '').hostname) }
    catch { return false }
  })
}
