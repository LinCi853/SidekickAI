import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
}))

describe('EffectScope', () => {
  let EffectScope: typeof import('./effect-scope.js').EffectScope

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('./effect-scope.js')
    EffectScope = mod.EffectScope
  })

  describe('constructor', () => {
    it('should create scope with label and ownerModule', () => {
      const scope = new EffectScope('test', 'test-module')
      expect(scope.label).toBe('test')
      expect(scope.ownerModule).toBe('test-module')
    })

    it('should use label as ownerModule if not provided', () => {
      const scope = new EffectScope('test')
      expect(scope.ownerModule).toBe('test')
    })
  })

  describe('track', () => {
    it('should track an effect handle', () => {
      const scope = new EffectScope('test', 'test-module')
      const handle = {
        ownerModule: 'test-module',
        capabilityId: 'test.cap',
        kind: 'ipc' as const,
        dispose: vi.fn(),
      }

      scope.track(handle)
      expect(scope.size).toBe(1)
    })

    it('should track multiple handles', () => {
      const scope = new EffectScope('test', 'test-module')
      const handle1 = {
        ownerModule: 'test-module',
        capabilityId: 'test.cap1',
        kind: 'ipc' as const,
        dispose: vi.fn(),
      }
      const handle2 = {
        ownerModule: 'test-module',
        capabilityId: 'test.cap2',
        kind: 'hotkey' as const,
        dispose: vi.fn(),
      }

      scope.track(handle1)
      scope.track(handle2)
      expect(scope.size).toBe(2)
    })
  })

  describe('create', () => {
    it('should create and track an effect handle', () => {
      const scope = new EffectScope('test', 'test-module')
      const disposeFn = vi.fn()

      const handle = scope.create('ipc', 'test.cap', disposeFn, 'target-1')

      expect(handle.ownerModule).toBe('test-module')
      expect(handle.capabilityId).toBe('test.cap')
      expect(handle.kind).toBe('ipc')
      expect(handle.targetId).toBe('target-1')
      expect(scope.size).toBe(1)
    })
  })

  describe('ipcHandle', () => {
    it('should register IPC handle and track channel', async () => {
      const { ipcMain } = await import('electron')
      const scope = new EffectScope('test', 'test-module')
      const handler = vi.fn()

      scope.ipcHandle('test:channel', handler)

      expect(ipcMain.handle).toHaveBeenCalledWith('test:channel', handler)
    })
  })

  describe('ipcOn', () => {
    it('should register IPC listener and track channel', async () => {
      const { ipcMain } = await import('electron')
      const scope = new EffectScope('test', 'test-module')
      const listener = vi.fn()

      scope.ipcOn('test:event', listener)

      expect(ipcMain.on).toHaveBeenCalledWith('test:event', listener)
    })
  })

  describe('trackIpc', () => {
    it('should track multiple IPC channels', () => {
      const scope = new EffectScope('test', 'test-module')

      scope.trackIpc('channel1', 'channel2', 'channel3')

      // Channels are tracked internally for cleanup
      expect(scope.size).toBe(3)
    })
  })

  describe('dispose', () => {
    it('should dispose all tracked handles', async () => {
      const scope = new EffectScope('test', 'test-module')
      const dispose1 = vi.fn()
      const dispose2 = vi.fn()

      scope.create('ipc', 'test.cap1', dispose1)
      scope.create('hotkey', 'test.cap2', dispose2)

      await scope.dispose()

      expect(dispose1).toHaveBeenCalled()
      expect(dispose2).toHaveBeenCalled()
      expect(scope.size).toBe(0)
    })

    it('should remove all IPC handlers', async () => {
      const { ipcMain } = await import('electron')
      const scope = new EffectScope('test', 'test-module')

      scope.ipcHandle('channel1', vi.fn())
      scope.ipcHandle('channel2', vi.fn())

      await scope.dispose()

      expect(ipcMain.removeHandler).toHaveBeenCalledWith('channel1')
      expect(ipcMain.removeHandler).toHaveBeenCalledWith('channel2')
      expect(ipcMain.removeAllListeners).toHaveBeenCalledWith('channel1')
      expect(ipcMain.removeAllListeners).toHaveBeenCalledWith('channel2')
    })

    it('should clear all timers', async () => {
      const scope = new EffectScope('test', 'test-module')

      scope.managedSetTimeout(vi.fn(), 1000)
      scope.managedSetInterval(vi.fn(), 1000)

      await scope.dispose()

      expect(scope.size).toBe(0)
    })

    it('should be idempotent', async () => {
      const scope = new EffectScope('test', 'test-module')
      const dispose = vi.fn()

      scope.create('ipc', 'test.cap', dispose)

      await scope.dispose()
      await scope.dispose()

      // dispose should only be called once
      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  describe('getHandlesByModule', () => {
    it('should filter handles by module', () => {
      const scope = new EffectScope('test', 'test-module')

      scope.create('ipc', 'test.cap1', vi.fn())
      scope.create('hotkey', 'test.cap2', vi.fn())

      const handles = scope.getHandlesByModule('test-module')
      expect(handles).toHaveLength(2)
    })

    it('should return empty array for unknown module', () => {
      const scope = new EffectScope('test', 'test-module')

      scope.create('ipc', 'test.cap1', vi.fn())

      const handles = scope.getHandlesByModule('other-module')
      expect(handles).toHaveLength(0)
    })
  })

  describe('getHandlesByKind', () => {
    it('should filter handles by kind', () => {
      const scope = new EffectScope('test', 'test-module')

      scope.create('ipc', 'test.cap1', vi.fn())
      scope.create('hotkey', 'test.cap2', vi.fn())
      scope.create('ipc', 'test.cap3', vi.fn())

      const ipcHandles = scope.getHandlesByKind('ipc')
      expect(ipcHandles).toHaveLength(2)

      const hotkeyHandles = scope.getHandlesByKind('hotkey')
      expect(hotkeyHandles).toHaveLength(1)
    })
  })
})
