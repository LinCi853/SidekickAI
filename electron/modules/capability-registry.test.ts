import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('CapabilityRegistry', () => {
  let capabilityRegistry: typeof import('./capability-registry.js').capabilityRegistry

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./capability-registry.js')
    capabilityRegistry = mod.capabilityRegistry
  })

  describe('register', () => {
    it('should register a capability', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      expect(capabilityRegistry.has('test.cap')).toBe(true)
    })

    it('should throw on duplicate registration', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      expect(() => {
        capabilityRegistry.register({
          ownerModule: 'test-module',
          capabilityId: 'test.cap',
          kind: 'ipc',
          scope: 'global',
          trigger: 'startup',
          reversible: true,
        })
      }).toThrow('能力重复注册: test.cap')
    })
  })

  describe('registerMany', () => {
    it('should register multiple capabilities', () => {
      capabilityRegistry.registerMany([
        {
          ownerModule: 'test-module',
          capabilityId: 'test.cap1',
          kind: 'ipc',
          scope: 'global',
          trigger: 'startup',
          reversible: true,
        },
        {
          ownerModule: 'test-module',
          capabilityId: 'test.cap2',
          kind: 'hotkey',
          scope: 'global',
          trigger: 'startup',
          reversible: true,
        },
      ])

      expect(capabilityRegistry.has('test.cap1')).toBe(true)
      expect(capabilityRegistry.has('test.cap2')).toBe(true)
    })
  })

  describe('get', () => {
    it('should return capability by id', () => {
      const cap = {
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc' as const,
        scope: 'global' as const,
        trigger: 'startup' as const,
        reversible: true,
        description: 'Test capability',
      }

      capabilityRegistry.register(cap)

      const result = capabilityRegistry.get('test.cap')
      expect(result).toEqual(cap)
    })

    it('should return undefined for unknown capability', () => {
      const result = capabilityRegistry.get('unknown.cap')
      expect(result).toBeUndefined()
    })
  })

  describe('getByModule', () => {
    it('should return all capabilities for a module', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap1',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap2',
        kind: 'hotkey',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'other-module',
        capabilityId: 'other.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      const caps = capabilityRegistry.getByModule('test-module')
      expect(caps).toHaveLength(2)
      expect(caps.map((c) => c.capabilityId)).toContain('test.cap1')
      expect(caps.map((c) => c.capabilityId)).toContain('test.cap2')
    })

    it('should return empty array for unknown module', () => {
      const caps = capabilityRegistry.getByModule('unknown-module')
      expect(caps).toHaveLength(0)
    })
  })

  describe('getByKind', () => {
    it('should return all capabilities of a kind', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.ipc1',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.ipc2',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.hotkey',
        kind: 'hotkey',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      const ipcCaps = capabilityRegistry.getByKind('ipc')
      expect(ipcCaps).toHaveLength(2)

      const hotkeyCaps = capabilityRegistry.getByKind('hotkey')
      expect(hotkeyCaps).toHaveLength(1)
    })
  })

  describe('getAll', () => {
    it('should return all registered capabilities', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap1',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'other-module',
        capabilityId: 'other.cap',
        kind: 'hotkey',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      const all = capabilityRegistry.getAll()
      expect(all).toHaveLength(2)
    })
  })

  describe('unregisterModule', () => {
    it('should remove all capabilities for a module', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap1',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap2',
        kind: 'hotkey',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      capabilityRegistry.unregisterModule('test-module')

      expect(capabilityRegistry.has('test.cap1')).toBe(false)
      expect(capabilityRegistry.has('test.cap2')).toBe(false)
      expect(capabilityRegistry.getByModule('test-module')).toHaveLength(0)
    })

    it('should not affect other modules', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })
      capabilityRegistry.register({
        ownerModule: 'other-module',
        capabilityId: 'other.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      capabilityRegistry.unregisterModule('test-module')

      expect(capabilityRegistry.has('test.cap')).toBe(false)
      expect(capabilityRegistry.has('other.cap')).toBe(true)
    })
  })

  describe('has', () => {
    it('should return true for registered capability', () => {
      capabilityRegistry.register({
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc',
        scope: 'global',
        trigger: 'startup',
        reversible: true,
      })

      expect(capabilityRegistry.has('test.cap')).toBe(true)
    })

    it('should return false for unregistered capability', () => {
      expect(capabilityRegistry.has('unknown.cap')).toBe(false)
    })
  })
})
