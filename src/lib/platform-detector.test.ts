import { describe, expect, it, vi, beforeEach } from 'vitest'

describe('platform-detector', () => {
  let platformDetector: typeof import('./platform-detector.js')

  beforeEach(async () => {
    vi.resetModules()
    platformDetector = await import('./platform-detector.js')
  })

  describe('detectPlatform', () => {
    it('should return a valid platform string', () => {
      const platform = platformDetector.detectPlatform()
      expect(['electron', 'mobile', 'web']).toContain(platform)
    })
  })

  describe('isElectron', () => {
    it('should return a boolean', () => {
      expect(typeof platformDetector.isElectron()).toBe('boolean')
    })
  })

  describe('isMobile', () => {
    it('should return a boolean', () => {
      expect(typeof platformDetector.isMobile()).toBe('boolean')
    })
  })

  describe('PLATFORM', () => {
    it('should be a string', () => {
      expect(typeof platformDetector.PLATFORM).toBe('string')
    })

    it('should be one of electron, mobile, web', () => {
      expect(['electron', 'mobile', 'web']).toContain(platformDetector.PLATFORM)
    })
  })
})
