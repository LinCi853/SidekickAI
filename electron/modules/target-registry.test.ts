import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('TargetRegistry', () => {
  let targetRegistry: typeof import('./target-registry.js').targetRegistry

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./target-registry.js')
    targetRegistry = mod.targetRegistry
  })

  describe('register', () => {
    it('should register a target', () => {
      const record = targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      expect(record.targetId).toBe('target-1')
      expect(record.type).toBe('webview')
      expect(record.state).toBe('active')
    })

    it('should overwrite existing target with same id', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      const record = targetRegistry.register({
        targetId: 'target-1',
        type: 'tab',
        nativeId: '2',
      })

      expect(record.type).toBe('tab')
      expect(record.nativeId).toBe('2')
    })
  })

  describe('unregister', () => {
    it('should unregister a target', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      const result = targetRegistry.unregister('target-1')
      expect(result).toBe(true)
      expect(targetRegistry.get('target-1')).toBeUndefined()
    })

    it('should return false for unknown target', () => {
      const result = targetRegistry.unregister('unknown')
      expect(result).toBe(false)
    })
  })

  describe('get', () => {
    it('should return target by id', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      const record = targetRegistry.get('target-1')
      expect(record).toBeDefined()
      expect(record?.targetId).toBe('target-1')
    })

    it('should return undefined for unknown target', () => {
      const record = targetRegistry.get('unknown')
      expect(record).toBeUndefined()
    })
  })

  describe('getByNativeId', () => {
    it('should return target by native id', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: 'native-1',
      })

      const record = targetRegistry.getByNativeId('native-1')
      expect(record).toBeDefined()
      expect(record?.targetId).toBe('target-1')
    })
  })

  describe('getByWebContentsId', () => {
    it('should return target by webContents id', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
        webContentsId: 42,
      })

      const record = targetRegistry.getByWebContentsId(42)
      expect(record).toBeDefined()
      expect(record?.targetId).toBe('target-1')
    })
  })

  describe('getByType', () => {
    it('should return all targets of a type', () => {
      targetRegistry.register({
        targetId: 'webview-1',
        type: 'webview',
        nativeId: '1',
      })
      targetRegistry.register({
        targetId: 'webview-2',
        type: 'webview',
        nativeId: '2',
      })
      targetRegistry.register({
        targetId: 'tab-1',
        type: 'tab',
        nativeId: '3',
      })

      const webviews = targetRegistry.getByType('webview')
      expect(webviews).toHaveLength(2)

      const tabs = targetRegistry.getByType('tab')
      expect(tabs).toHaveLength(1)
    })
  })

  describe('getByOwner', () => {
    it('should return all targets for an owner module', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
        ownerModule: 'test-module',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
        ownerModule: 'test-module',
      })
      targetRegistry.register({
        targetId: 'target-3',
        type: 'webview',
        nativeId: '3',
        ownerModule: 'other-module',
      })

      const targets = targetRegistry.getByOwner('test-module')
      expect(targets).toHaveLength(2)
    })
  })

  describe('getByProfile', () => {
    it('should return all targets for a profile', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
        profileId: 'profile-1',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
        profileId: 'profile-1',
      })

      const targets = targetRegistry.getByProfile('profile-1')
      expect(targets).toHaveLength(2)
    })
  })

  describe('updateState', () => {
    it('should update target state', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      const result = targetRegistry.updateState('target-1', 'destroyed')
      expect(result).toBe(true)

      const record = targetRegistry.get('target-1')
      expect(record?.state).toBe('destroyed')
    })

    it('should return false for unknown target', () => {
      const result = targetRegistry.updateState('unknown', 'destroyed')
      expect(result).toBe(false)
    })
  })

  describe('bumpDocumentGeneration', () => {
    it('should increment document generation', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })

      const gen1 = targetRegistry.bumpDocumentGeneration('target-1')
      expect(gen1).toBe(1)

      const gen2 = targetRegistry.bumpDocumentGeneration('target-1')
      expect(gen2).toBe(2)
    })

    it('should return -1 for unknown target', () => {
      const result = targetRegistry.bumpDocumentGeneration('unknown')
      expect(result).toBe(-1)
    })
  })

  describe('getActive', () => {
    it('should return only active targets', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
      })

      targetRegistry.updateState('target-2', 'destroyed')

      const active = targetRegistry.getActive()
      expect(active).toHaveLength(1)
      expect(active[0].targetId).toBe('target-1')
    })
  })

  describe('getAll', () => {
    it('should return all targets', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
      })

      const all = targetRegistry.getAll()
      expect(all).toHaveLength(2)
    })
  })

  describe('getStats', () => {
    it('should return statistics', () => {
      targetRegistry.register({
        targetId: 'webview-1',
        type: 'webview',
        nativeId: '1',
      })
      targetRegistry.register({
        targetId: 'tab-1',
        type: 'tab',
        nativeId: '2',
      })
      targetRegistry.register({
        targetId: 'webview-2',
        type: 'webview',
        nativeId: '3',
      })

      targetRegistry.updateState('webview-2', 'destroyed')

      const stats = targetRegistry.getStats()
      expect(stats.total).toBe(3)
      expect(stats.active).toBe(2)
      expect(stats.byType.webview).toBe(2)
      expect(stats.byType.tab).toBe(1)
    })
  })

  describe('markOwnerDestroyed', () => {
    it('should mark all targets of an owner as destroyed', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
        ownerModule: 'test-module',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
        ownerModule: 'test-module',
      })

      const count = targetRegistry.markOwnerDestroyed('test-module')
      expect(count).toBe(2)

      const targets = targetRegistry.getByOwner('test-module')
      expect(targets.every((t) => t.state === 'destroyed')).toBe(true)
    })
  })

  describe('cleanupDestroyed', () => {
    it('should remove all destroyed targets', () => {
      targetRegistry.register({
        targetId: 'target-1',
        type: 'webview',
        nativeId: '1',
      })
      targetRegistry.register({
        targetId: 'target-2',
        type: 'tab',
        nativeId: '2',
      })

      targetRegistry.updateState('target-1', 'destroyed')

      const count = targetRegistry.cleanupDestroyed()
      expect(count).toBe(1)
      expect(targetRegistry.getAll()).toHaveLength(1)
    })
  })
})
