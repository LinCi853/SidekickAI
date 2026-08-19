import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
vi.mock('./feature-gate.js', () => ({
  featureGate: {
    assertModuleEnabled: vi.fn(),
    assertCapability: vi.fn(),
  },
}))

vi.mock('./capability-registry.js', () => ({
  capabilityRegistry: {
    has: vi.fn(() => false),
  },
}))

describe('InjectionBroker', () => {
  let injectionBroker: typeof import('./injection-broker.js').injectionBroker
  let mockGate: { assertModuleEnabled: ReturnType<typeof vi.fn>; assertCapability: ReturnType<typeof vi.fn> }
  let mockCapRegistry: { has: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.resetModules()
    mockGate = (await import('./feature-gate.js')).featureGate as unknown as typeof mockGate
    mockCapRegistry = (await import('./capability-registry.js')).capabilityRegistry as unknown as typeof mockCapRegistry
    const mod = await import('./injection-broker.js')
    injectionBroker = mod.injectionBroker
  })

  describe('registerAdapter', () => {
    it('should register an adapter', () => {
      const adapter = {
        kind: 'ipc' as const,
        apply: vi.fn(),
      }

      injectionBroker.registerAdapter(adapter)

      // Should not throw when injecting with registered adapter
      expect(() => injectionBroker.registerAdapter(adapter)).not.toThrow()
    })
  })

  describe('registerAdapters', () => {
    it('should register multiple adapters', () => {
      const adapters = [
        { kind: 'ipc' as const, apply: vi.fn() },
        { kind: 'hotkey' as const, apply: vi.fn() },
      ]

      injectionBroker.registerAdapters(adapters)
      // Should not throw
    })
  })

  describe('inject', () => {
    it('should throw when module is disabled', async () => {
      mockGate.assertModuleEnabled.mockImplementation(() => {
        throw new Error('Module disabled')
      })

      const scope = {
        ownerModule: 'test-module',
        track: vi.fn(),
      }

      await expect(
        injectionBroker.inject(
          {
            ownerModule: 'test-module',
            capabilityId: 'test.cap',
            kind: 'ipc',
            payload: { channel: 'test:channel', handler: vi.fn(), mode: 'handle' },
          },
          scope as any,
        ),
      ).rejects.toThrow('Module disabled')
    })

    it('should throw when adapter is not registered', async () => {
      mockGate.assertModuleEnabled.mockImplementation(() => {})

      const scope = {
        ownerModule: 'test-module',
        track: vi.fn(),
      }

      await expect(
        injectionBroker.inject(
          {
            ownerModule: 'test-module',
            capabilityId: 'test.cap',
            kind: 'ipc',
            payload: { channel: 'test:channel', handler: vi.fn(), mode: 'handle' },
          },
          scope as any,
        ),
      ).rejects.toThrow('未注册适配器: ipc')
    })

    it('should inject and return handle when adapter is registered', async () => {
      mockGate.assertModuleEnabled.mockImplementation(() => {})
      const mockApply = vi.fn().mockResolvedValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        dispose: vi.fn(),
      })

      injectionBroker.registerAdapter({
        kind: 'ipc',
        apply: mockApply,
      })

      const scope = {
        ownerModule: 'test-module',
        track: vi.fn(),
      }

      const request = {
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc' as const,
        payload: { channel: 'test:channel', handler: vi.fn(), mode: 'handle' },
      }

      const handle = await injectionBroker.inject(request, scope as any)

      expect(handle).toBeDefined()
      expect(handle.ownerModule).toBe('test-module')
      expect(scope.track).toHaveBeenCalledWith(handle)
    })
  })

  describe('revokeModule', () => {
    it('should revoke all handles for a module', async () => {
      const dispose1 = vi.fn()
      const dispose2 = vi.fn()

      mockGate.assertModuleEnabled.mockImplementation(() => {})
      injectionBroker.registerAdapter({
        kind: 'ipc',
        apply: vi.fn().mockResolvedValue({
          ownerModule: 'test-module',
          capabilityId: 'test.cap1',
          kind: 'ipc',
          dispose: dispose1,
        }),
      })

      const scope = {
        ownerModule: 'test-module',
        track: vi.fn(),
      }

      await injectionBroker.inject(
        {
          ownerModule: 'test-module',
          capabilityId: 'test.cap1',
          kind: 'ipc',
          payload: {},
        },
        scope as any,
      )

      await injectionBroker.revokeModule('test-module')

      expect(dispose1).toHaveBeenCalled()
      expect(injectionBroker.getModuleInjectionCount('test-module')).toBe(0)
    })
  })

  describe('revokeTarget', () => {
    it('should revoke all handles for a target', async () => {
      const dispose = vi.fn()

      mockGate.assertModuleEnabled.mockImplementation(() => {})
      injectionBroker.registerAdapter({
        kind: 'ipc',
        apply: vi.fn().mockResolvedValue({
          ownerModule: 'test-module',
          capabilityId: 'test.cap',
          targetId: 'target-1',
          kind: 'ipc',
          dispose,
        }),
      })

      const scope = {
        ownerModule: 'test-module',
        track: vi.fn(),
      }

      await injectionBroker.inject(
        {
          ownerModule: 'test-module',
          capabilityId: 'test.cap',
          kind: 'ipc',
          target: { type: 'tab', id: 'target-1' },
          payload: {},
        },
        scope as any,
      )

      await injectionBroker.revokeTarget('target-1')

      expect(dispose).toHaveBeenCalled()
    })
  })

  describe('getModuleInjectionCount', () => {
    it('should return 0 for module with no injections', () => {
      expect(injectionBroker.getModuleInjectionCount('unknown-module')).toBe(0)
    })
  })

  describe('getTotalInjectionCount', () => {
    it('should return 0 when no injections', () => {
      expect(injectionBroker.getTotalInjectionCount()).toBe(0)
    })
  })

  describe('getAuditLog', () => {
    it('should return empty log initially', () => {
      expect(injectionBroker.getAuditLog()).toHaveLength(0)
    })
  })
})
