import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
vi.mock('./registry.js', () => ({
  isModuleEnabled: vi.fn(() => false),
  isModuleInstalled: vi.fn(() => true),
  assertModuleEnabled: vi.fn(),
}))

vi.mock('./capability-registry.js', () => ({
  capabilityRegistry: {
    get: vi.fn(),
    has: vi.fn(),
  },
}))

describe('FeatureGate', () => {
  let featureGate: typeof import('./feature-gate.js').featureGate
  let mockRegistry: { isModuleEnabled: ReturnType<typeof vi.fn>; isModuleInstalled: ReturnType<typeof vi.fn>; assertModuleEnabled: ReturnType<typeof vi.fn> }
  let mockCapRegistry: { get: ReturnType<typeof vi.fn>; has: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    vi.resetModules()
    mockRegistry = await import('./registry.js') as unknown as typeof mockRegistry
    mockCapRegistry = (await import('./capability-registry.js')).capabilityRegistry as unknown as typeof mockCapRegistry
    const mod = await import('./feature-gate.js')
    featureGate = mod.featureGate
  })

  describe('isModuleEnabled', () => {
    it('should delegate to registry', () => {
      mockRegistry.isModuleEnabled.mockReturnValue(true)
      expect(featureGate.isModuleEnabled('test-module')).toBe(true)
      expect(mockRegistry.isModuleEnabled).toHaveBeenCalledWith('test-module')
    })

    it('should return false for disabled module', () => {
      mockRegistry.isModuleEnabled.mockReturnValue(false)
      expect(featureGate.isModuleEnabled('test-module')).toBe(false)
    })
  })

  describe('isModuleInstalled', () => {
    it('should delegate to registry', () => {
      mockRegistry.isModuleInstalled.mockReturnValue(true)
      expect(featureGate.isModuleInstalled('test-module')).toBe(true)
      expect(mockRegistry.isModuleInstalled).toHaveBeenCalledWith('test-module')
    })
  })

  describe('assertModuleEnabled', () => {
    it('should delegate to registry', () => {
      featureGate.assertModuleEnabled('test-module', 'test action')
      expect(mockRegistry.assertModuleEnabled).toHaveBeenCalledWith('test-module', 'test action')
    })
  })

  describe('isCapabilityAvailable', () => {
    it('should return false for unregistered capability', () => {
      mockCapRegistry.get.mockReturnValue(undefined)
      expect(featureGate.isCapabilityAvailable('unknown.cap')).toBe(false)
    })

    it('should return false when module is disabled', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      mockRegistry.isModuleEnabled.mockReturnValue(false)

      expect(featureGate.isCapabilityAvailable('test.cap')).toBe(false)
    })

    it('should return true when module is enabled and no dependencies', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      mockRegistry.isModuleEnabled.mockReturnValue(true)

      expect(featureGate.isCapabilityAvailable('test.cap')).toBe(true)
    })

    it('should return false when dependency module is disabled', () => {
      mockCapRegistry.get.mockImplementation((id: string) => {
        if (id === 'test.cap') {
          return {
            ownerModule: 'test-module',
            capabilityId: 'test.cap',
            kind: 'ipc',
            scope: 'global',
            trigger: 'startup',
            reversible: true,
            dependencies: ['dep-module'],
          }
        }
        // dep-module is not a capability, return undefined
        return undefined
      })
      mockCapRegistry.has.mockImplementation((id: string) => id === 'test.cap')
      mockRegistry.isModuleEnabled.mockImplementation((id: string) => {
        if (id === 'test-module') return true
        if (id === 'dep-module') return false
        return false
      })

      expect(featureGate.isCapabilityAvailable('test.cap')).toBe(false)
    })

    it('should return true when all dependencies are enabled', () => {
      mockCapRegistry.get.mockImplementation((id: string) => {
        if (id === 'test.cap') {
          return {
            ownerModule: 'test-module',
            capabilityId: 'test.cap',
            kind: 'ipc',
            scope: 'global',
            trigger: 'startup',
            reversible: true,
            dependencies: ['dep-module'],
          }
        }
        return undefined
      })
      mockCapRegistry.has.mockImplementation((id: string) => id === 'test.cap')
      mockRegistry.isModuleEnabled.mockReturnValue(true)

      expect(featureGate.isCapabilityAvailable('test.cap')).toBe(true)
    })
  })

  describe('assertCapability', () => {
    it('should not throw when capability is available', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      mockRegistry.isModuleEnabled.mockReturnValue(true)

      expect(() => featureGate.assertCapability('test.cap')).not.toThrow()
    })

    it('should throw when capability is not available', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      mockRegistry.isModuleEnabled.mockReturnValue(false)

      expect(() => featureGate.assertCapability('test.cap')).toThrow()
    })
  })

  describe('hasPermission', () => {
    it('should return true for capability without permission requirement', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      expect(featureGate.hasPermission('test.cap')).toBe(true)
    })

    it('should return true for built-in module without pluginId', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
        permission: 'script:inject',
      })

      expect(featureGate.hasPermission('test.cap')).toBe(true)
    })

    it('should return false for external plugin without granted permission', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
        permission: 'script:inject',
      })

      expect(featureGate.hasPermission('test.cap', 'external-plugin')).toBe(false)
    })

    it('should return true for external plugin with granted permission', () => {
      mockCapRegistry.get.mockReturnValue({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
        permission: 'script:inject',
      })

      featureGate.grantPermission('external-plugin', 'script:inject')
      expect(featureGate.hasPermission('test.cap', 'external-plugin')).toBe(true)
    })
  })

  describe('grantPermission / revokePermission', () => {
    it('should grant and revoke permissions', () => {
      featureGate.grantPermission('plugin-1', 'script:inject')
      expect(featureGate.getPluginPermissions('plugin-1')).toContain('script:inject')

      featureGate.revokePermission('plugin-1', 'script:inject')
      expect(featureGate.getPluginPermissions('plugin-1')).not.toContain('script:inject')
    })
  })

  describe('registerPermissionRule', () => {
    it('should register permission rules', () => {
      featureGate.registerPermissionRule({
        permission: 'script:inject',
        level: 'allow',
        pluginIds: ['trusted-plugin'],
      })

      const rules = featureGate.getPermissionRules()
      expect(rules).toHaveLength(1)
      expect(rules[0].permission).toBe('script:inject')
    })
  })
})
