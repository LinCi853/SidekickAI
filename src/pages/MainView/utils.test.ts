import { describe, expect, it } from 'vitest'
import type { AIPlatform, Profile } from '../../lib/electron-api'
import { getPlatformColors } from './utils'

describe('profile accents', () => {
  const platform = { themeColor: '#4d6bfe', gradientColor: '#2e4fd9' } as AIPlatform
  it('keeps two configurations of a platform independent', () => {
    const own = getPlatformColors({ aiThemeColor: '#ee8844' } as Profile, platform, 'second')
    expect(own).toEqual({ themeColor: '#ee8844', gradientColor: '#be6d36' })
    expect(getPlatformColors({ aiThemeColor: '#4D6BFE' } as Profile, platform, 'first').gradientColor).toBe('#2e4fd9')
  })
  it('derives short hexadecimal colors and retains preset defaults', () => {
    expect(getPlatformColors({ aiThemeColor: '#aBc' } as Profile, platform, 'short').gradientColor).toBe('#8896a3')
    expect(getPlatformColors(undefined, platform, 'unset')).toEqual(platform)
  })
})
