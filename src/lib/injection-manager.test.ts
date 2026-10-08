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
  listAIPlatforms: vi.fn(() => Promise.resolve([])),
  onAppSettingsChanged: vi.fn(() => () => {}),
  onBlockRulesChanged: vi.fn(() => () => {}),
}))

// Mock webview-blocker
vi.mock('./webview-blocker', () => ({
  buildBlockerScript: vi.fn(() => 'blocker-script'),
  buildBlockerCleanupScript: vi.fn(() => 'blocker-cleanup'),
  matchDomain: vi.fn((pattern: string, host: string) => pattern === '*' || pattern === host),
}))

// Mock cookie-handler
vi.mock('./cookie-handler', () => ({
  buildCookieHandlerScript: vi.fn(() => 'cookie-script'),
  buildCookieHandlerCleanupScript: vi.fn(() => 'cookie-cleanup'),
}))

// Mock webview-spatial-nav
vi.mock('./webview-spatial-nav', () => ({
  buildSpatialNavScript: vi.fn(() => 'spatial-nav-script'),
  buildSpatialNavCleanupScript: vi.fn(() => 'spatial-cleanup'),
}))

// Mock scripts
vi.mock('../pages/MainView/scripts', () => ({
  SCRAPE_CHAT_SCRIPT: 'scrape-script',
  DETECT_LOGIN_SCRIPT: 'login-detect-script',
  buildEnterToSendScript: vi.fn(() => 'enter-script'),
  buildEnterToSendCleanupScript: vi.fn(() => 'enter-cleanup'),
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
    it('resolves declarative application data through the list API and retains account selectors', async () => {
      const api = await import('./electron-api')
      const scripts = await import('../pages/MainView/scripts')
      const pageAdapter = { version: 1 as const, hosts: ['custom.example'], messageEdit: {
        rootSelector: '.history-edit', sendSelector: '.confirm', cancelSelector: '.cancel',
      } }
      vi.mocked(api.listAIPlatforms).mockResolvedValueOnce([{ id: 'custom', pageAdapter } as never])
      await registerDefaultInjectionPoints()
      const webview = { executeJavaScript: vi.fn(async () => undefined) }
      await injectionManager.injectAll('custom-app', webview, 'https://custom.example/chat', {
        manageEnterToSend: true, profile: { id: 'account', isAIPlatform: true, aiPlatformId: 'custom' },
        inputSelector: '#account-input', sendSelector: '#account-send',
      })
      expect(scripts.buildEnterToSendScript).toHaveBeenLastCalledWith({ enabled: true,
        inputSelector: '#account-input', sendSelector: '#account-send', pageAdapter })
      expect(webview.executeJavaScript).toHaveBeenCalledWith('enter-script')
    })

    it('resolves legacy application profiles by their saved URL', async () => {
      const api = await import('./electron-api')
      const scripts = await import('../pages/MainView/scripts')
      const pageAdapter = { version: 1 as const, hosts: ['legacy.example'], messageEdit: {
        rootSelector: '.history-edit', sendSelector: '.confirm', cancelSelector: '.cancel',
      } }
      vi.mocked(api.listAIPlatforms).mockResolvedValueOnce([{ id: 'legacy', url: 'https://legacy.example',
        inputSelector: '#legacy-input', sendSelector: '#legacy-send', pageAdapter } as never])
      await registerDefaultInjectionPoints()
      await injectionManager.injectAll('legacy-app', { executeJavaScript: vi.fn(async () => undefined) }, 'https://legacy.example/chat', {
        manageEnterToSend: true, profile: { id: 'account', isAIPlatform: true, aiPlatformUrl: 'https://legacy.example' },
      })
      expect(scripts.buildEnterToSendScript).toHaveBeenLastCalledWith({ enabled: true,
        inputSelector: '#legacy-input', sendSelector: '#legacy-send', pageAdapter })
    })

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

  describe('target ownership', () => {
    it('coalesces concurrent calls for the same guest and point', async () => {
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', enabled: () => true })
      await Promise.all([injectionManager.injectAll('guest', webview, 'https://example.com'),
        injectionManager.injectAll('guest', webview, 'https://example.com')])
      expect(webview.executeJavaScript).toHaveBeenCalledTimes(1)
    })

    it('does not carry injection records into a replacement guest at the same URL', async () => {
      const oldGuest = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      const newGuest = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', enabled: () => true })
      await injectionManager.injectAll('guest', oldGuest, 'https://example.com')
      await injectionManager.injectAll('guest', newGuest, 'https://example.com')
      expect(newGuest.executeJavaScript).toHaveBeenCalledWith('binding')
      expect(injectionManager.getStats().totalInjections).toBe(1)
    })

    it('rebinds a new document generation at an unchanged URL', async () => {
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', enabled: () => true })
      await injectionManager.injectAll('guest', webview, 'https://example.com', { pageGeneration: 1 })
      await injectionManager.injectAll('guest', webview, 'https://example.com', { pageGeneration: 2 })
      expect(webview.executeJavaScript).toHaveBeenCalledTimes(2)
    })

    it('retires pending script generation before page disposal', async () => {
      let release: (script: string) => void = () => {}
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      const generated = new Promise<string>(resolve => { release = resolve })
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => generated, enabled: () => true })
      const pending = injectionManager.injectAll('guest', webview, 'https://example.com')
      await Promise.resolve()
      await Promise.resolve()
      await injectionManager.disposeWebview('guest')
      release('late-binding')
      await pending
      expect(webview.executeJavaScript).not.toHaveBeenCalled()
      expect(injectionManager.getStatus('guest')).toEqual([])
    })

    it('honors a caller target guard after an asynchronous preference read', async () => {
      let current = true
      let release: (enabled: boolean) => void = () => {}
      const enabled = new Promise<boolean>(resolve => { release = resolve })
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', enabled: () => enabled })
      const pending = injectionManager.injectAll('guest', webview, 'https://example.com', { isCurrent: () => current })
      await Promise.resolve()
      current = false
      release(true)
      await pending
      expect(webview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('cleans owned scripts when disabled and when explicitly disposed', async () => {
      let enabled = true
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', cleanupScriptFn: () => 'cleanup', enabled: () => enabled })
      await injectionManager.injectAll('guest', webview, 'https://example.com')
      enabled = false
      await injectionManager.injectAll('guest', webview, 'https://example.com')
      expect(webview.executeJavaScript.mock.calls.map(call => call[0])).toEqual(['binding', 'cleanup'])
      enabled = true
      await injectionManager.injectAll('guest', webview, 'https://example.com')
      await injectionManager.disposeWebview('guest')
      expect(webview.executeJavaScript.mock.calls.map(call => call[0])).toEqual(['binding', 'cleanup', 'binding', 'cleanup'])
    })

    it('cancels pending module-owned work while retaining other points', async () => {
      let release: (script: string) => void = () => {}
      const generated = new Promise<string>(resolve => { release = resolve })
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', ownerModule: 'browser', scriptFn: () => generated, enabled: () => true })
      const pending = injectionManager.injectOne('point', 'guest', webview)
      await Promise.resolve()
      await injectionManager.disposeModule('browser')
      release('late-binding')
      expect(await pending).toBe(false)
      expect(webview.executeJavaScript).not.toHaveBeenCalled()
    })

    it('updates changed configuration on the same document', async () => {
      let script = 'original'
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => script, cleanupScriptFn: () => 'cleanup',
        enabled: () => true, reinjectOnNavigation: true })
      await injectionManager.injectAll('guest', webview, 'https://example.com')
      script = 'changed'
      await injectionManager.injectAll('guest', webview, 'https://example.com')
      expect(webview.executeJavaScript.mock.calls.map(call => call[0])).toEqual(['original', 'cleanup', 'changed'])
    })

    it('matches default rules against the guest URL', async () => {
      const api = await import('./electron-api')
      vi.mocked(api.listBlockRules).mockResolvedValueOnce([{ id: 'guest-rule', label: 'Guest', type: 'css', selector: '.ad',
        domainPattern: 'chatgpt.com', enabled: true, builtin: false }])
      await registerDefaultInjectionPoints()
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      await injectionManager.injectAll('guest', webview, 'https://chatgpt.com/c/test', undefined,
        ['spatial-nav', 'login-detect', 'chat-scrape', 'cookie-handler'])
      expect(webview.executeJavaScript).toHaveBeenCalledWith('blocker-script')
    })

    it('retains old resource cleanup when a same-element navigation disables a point', async () => {
      let enabled = true
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', scriptFn: () => 'binding', cleanupScriptFn: () => 'cleanup',
        enabled: () => enabled, reinjectOnNavigation: true })
      await injectionManager.injectAll('guest', webview, 'https://example.com/a', { pageGeneration: 1 })
      enabled = false
      await injectionManager.injectAll('guest', webview, 'https://example.com/b', { pageGeneration: 2 })
      expect(webview.executeJavaScript.mock.calls.map(call => call[0])).toEqual(['binding', 'cleanup'])
    })

    it('applies the latest context after a previous configuration is still generating', async () => {
      let release: (script: string) => void = () => {}
      const previous = new Promise<string>(resolve => { release = resolve })
      const webview = { executeJavaScript: vi.fn(async (_script: string) => {}) }
      injectionManager.register({ id: 'point', kind: 'custom', enabled: () => true, reinjectOnNavigation: true,
        scriptFn: context => context?.revision === 1 ? previous : 'changed', cleanupScriptFn: () => 'cleanup' })
      const first = injectionManager.injectOne('point', 'guest', webview, { url: 'https://example.com', revision: 1 })
      await Promise.resolve(); await Promise.resolve()
      const second = injectionManager.injectOne('point', 'guest', webview, { url: 'https://example.com', revision: 2 })
      release('previous')
      await Promise.all([first, second])
      expect(webview.executeJavaScript).toHaveBeenLastCalledWith('changed')
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
      expect(injectionManager.has('enter-to-send')).toBe(true)
      expect(injectionManager.has('login-detect')).toBe(false)
      expect(injectionManager.has('chat-scrape')).toBe(false)
    })
  })
})
