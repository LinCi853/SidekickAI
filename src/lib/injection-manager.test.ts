import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron-api
vi.mock('./electron-api', () => ({
  listBlockRules: vi.fn(() => Promise.resolve([])),
  getAppSettings: vi.fn(() => Promise.resolve({
    disableAllBlockRules: false,
    cookieHandlerEnabled: true,
    enterToSend: true,
  })),
  getFingerprintScript: vi.fn(() => Promise.resolve('fingerprint-script')),
}))

// Mock webview-blocker
vi.mock('./webview-blocker', () => ({
  buildBlockerScript: vi.fn(() => 'blocker-script'),
}))

// Mock cookie-handler
vi.mock('./cookie-handler', () => ({
  buildCookieHandlerScript: vi.fn(() => 'cookie-script'),
}))

// Mock webview-spatial-nav
vi.mock('./webview-spatial-nav', () => ({
  buildSpatialNavScript: vi.fn(() => 'spatial-nav-script'),
}))

// Mock scripts
vi.mock('../pages/MainView/scripts', () => ({
  SCRAPE_CHAT_SCRIPT: 'scrape-script',
  DETECT_LOGIN_SCRIPT: 'login-detect-script',
}))

// Mock webview
vi.mock('./webview', () => ({
  injectViewportAndPopupGuard: vi.fn(() => Promise.resolve()),
}))

describe('InjectionManager', () => {
  let injectionManager: typeof import('./injection-manager.js').injectionManager
  let registerDefaultInjectionPoints: typeof import('./injection-manager.js').registerDefaultInjectionPoints

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./injection-manager.js')
    injectionManager = mod.injectionManager
    registerDefaultInjectionPoints = mod.registerDefaultInjectionPoints
  })

  describe('register', () => {
    it('should register an injection point', () => {
      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      expect(injectionManager.has('test-point')).toBe(true)
    })
  })

  describe('registerMany', () => {
    it('should register multiple injection points', () => {
      injectionManager.registerMany([
        {
          id: 'point-1',
          kind: 'custom',
          scriptFn: () => 'script-1',
          enabled: () => true,
        },
        {
          id: 'point-2',
          kind: 'custom',
          scriptFn: () => 'script-2',
          enabled: () => true,
        },
      ])

      expect(injectionManager.has('point-1')).toBe(true)
      expect(injectionManager.has('point-2')).toBe(true)
    })
  })

  describe('injectAll', () => {
    it('should inject all enabled points', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('test-script')
    })

    it('should skip disabled points', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => false,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      expect(mockWebview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('should skip points with null script', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => null,
        enabled: () => true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      expect(mockWebview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('should skip specified kinds', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'block-rules',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com', undefined, ['block-rules'])

      expect(mockWebview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('should not reinject when URL unchanged and reinjectOnNavigation is false', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
        reinjectOnNavigation: false,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')
      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      expect(mockWebview.executeJavaScript).toHaveBeenCalledTimes(1)
    })

    it('should reinject when URL changes and reinjectOnNavigation is true', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
        reinjectOnNavigation: true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')
      await injectionManager.injectAll('webview-1', mockWebview, 'https://other.com')

      expect(mockWebview.executeJavaScript).toHaveBeenCalledTimes(2)
    })
  })

  describe('injectOne', () => {
    it('should inject a single point', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      const result = await injectionManager.injectOne('test-point', 'webview-1', mockWebview)

      expect(result).toBe(true)
      expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('test-script')
    })

    it('should return false for unknown point', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      const result = await injectionManager.injectOne('unknown', 'webview-1', mockWebview)

      expect(result).toBe(false)
      expect(mockWebview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('should return false when point is disabled', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => false,
      })

      const result = await injectionManager.injectOne('test-point', 'webview-1', mockWebview)

      expect(result).toBe(false)
    })
  })

  describe('disposeWebview', () => {
    it('should dispose all injections for a webview', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      const status = injectionManager.getStatus('webview-1')
      expect(status).toHaveLength(1)

      injectionManager.disposeWebview('webview-1')

      const statusAfter = injectionManager.getStatus('webview-1')
      expect(statusAfter).toHaveLength(0)
    })
  })

  describe('getStatus', () => {
    it('should return injection status for a webview', async () => {
      const mockWebview = {
        executeJavaScript: vi.fn(() => Promise.resolve()),
      }

      injectionManager.register({
        id: 'test-point',
        kind: 'custom',
        scriptFn: () => 'test-script',
        enabled: () => true,
      })

      await injectionManager.injectAll('webview-1', mockWebview, 'https://example.com')

      const status = injectionManager.getStatus('webview-1')
      expect(status).toHaveLength(1)
      expect(status[0].pointId).toBe('test-point')
      expect(status[0].injected).toBe(true)
    })

    it('should return empty array for unknown webview', () => {
      const status = injectionManager.getStatus('unknown')
      expect(status).toHaveLength(0)
    })
  })

  describe('getStats', () => {
    it('should return statistics', () => {
      injectionManager.register({
        id: 'point-1',
        kind: 'custom',
        scriptFn: () => 'script-1',
        enabled: () => true,
      })
      injectionManager.register({
        id: 'point-2',
        kind: 'custom',
        scriptFn: () => 'script-2',
        enabled: () => true,
      })

      const stats = injectionManager.getStats()
      expect(stats.points).toBe(2)
    })
  })

  describe('registerDefaultInjectionPoints', () => {
    it('should register all default injection points', async () => {
      await registerDefaultInjectionPoints()

      expect(injectionManager.has('fingerprint')).toBe(true)
      expect(injectionManager.has('ua-viewport')).toBe(true)
      expect(injectionManager.has('block-rules')).toBe(true)
      expect(injectionManager.has('cookie-handler')).toBe(true)
      expect(injectionManager.has('spatial-nav')).toBe(true)
      expect(injectionManager.has('login-detect')).toBe(true)
      expect(injectionManager.has('chat-scrape')).toBe(true)
      // enter-to-send 已移至 buildEnterToSendScript() 处理，不在 injection-manager 注册
    })
  })
})
