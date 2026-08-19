import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}))

vi.mock('../shared/types.js', () => ({
  IPC_CHANNELS: {
    MODULE_STATE_CHANGED: 'module:stateChanged',
  },
}))

vi.mock('../shared/broadcast.js', () => ({
  broadcastToAllWindows: vi.fn(),
}))

vi.mock('../store/module-state-store.js', () => ({
  getModuleState: vi.fn(() => null),
  isLargeModuleInstalledByManifestFile: vi.fn(() => true),
  saveModuleState: vi.fn(),
}))

vi.mock('../hotkey/manager.js', () => ({
  getHotkeyManagerInstance: vi.fn(() => null),
}))

vi.mock('./wiring/hotkey-sync.js', () => ({
  syncAdvancedPanelHotkey: vi.fn(),
  syncBrowserProfileShortcuts: vi.fn(),
}))

vi.mock('./injection-broker.js', () => ({
  injectionBroker: {
    getModuleInjectionCount: vi.fn(() => 0),
  },
}))

vi.mock('./target-registry.js', () => ({
  targetRegistry: {
    getByOwner: vi.fn(() => []),
  },
}))

describe('ModuleRegistry', () => {
  let registry: typeof import('./registry.js')

  beforeEach(async () => {
    vi.resetModules()
    registry = await import('./registry.js')
  })

  describe('registerModule', () => {
    it('should register a module', () => {
      const manifest: ModuleManifest = {
        id: 'test-module',
        name: 'Test Module',
        description: 'A test module',
        category: 'stable',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: true,
        dependencies: [],
        entries: [],
        hotkeys: [],
      }

      registry.registerModule(manifest)

      expect(registry.getManifest('test-module')).toBeDefined()
      expect(registry.getManifest('test-module')?.name).toBe('Test Module')
    })

    it('should throw on duplicate registration', () => {
      const manifest: ModuleManifest = {
        id: 'test-module',
        name: 'Test Module',
        description: 'A test module',
        category: 'stable',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: true,
        dependencies: [],
        entries: [],
        hotkeys: [],
      }

      registry.registerModule(manifest)

      expect(() => registry.registerModule(manifest)).toThrow('模块重复注册: test-module')
    })
  })

  describe('getManifest', () => {
    it('should return manifest for registered module', () => {
      const manifest: ModuleManifest = {
        id: 'test-module',
        name: 'Test Module',
        description: 'A test module',
        category: 'stable',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: true,
        dependencies: [],
        entries: [],
        hotkeys: [],
      }

      registry.registerModule(manifest)

      const result = registry.getManifest('test-module')
      expect(result).toBeDefined()
      expect(result?.id).toBe('test-module')
    })

    it('should return undefined for unregistered module', () => {
      const result = registry.getManifest('unknown')
      expect(result).toBeUndefined()
    })
  })

  describe('listManifests', () => {
    it('should return all registered manifests', () => {
      const manifest1: ModuleManifest = {
        id: 'module-1',
        name: 'Module 1',
        description: 'First module',
        category: 'stable',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: true,
        dependencies: [],
        entries: [],
        hotkeys: [],
      }
      const manifest2: ModuleManifest = {
        id: 'module-2',
        name: 'Module 2',
        description: 'Second module',
        category: 'dev',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: false,
        dependencies: [],
        entries: [],
        hotkeys: [],
      }

      registry.registerModule(manifest1)
      registry.registerModule(manifest2)

      const manifests = registry.listManifests()
      expect(manifests).toHaveLength(2)
    })
  })

  describe('isModuleEnabled', () => {
    it('should return false for unregistered module', () => {
      expect(registry.isModuleEnabled('unknown')).toBe(false)
    })
  })

  describe('isModuleInstalled', () => {
    it('should return false for unregistered module', () => {
      expect(registry.isModuleInstalled('unknown')).toBe(false)
    })
  })

  describe('assertModuleEnabled', () => {
    it('should throw for disabled module', () => {
      expect(() => registry.assertModuleEnabled('unknown')).toThrow('模块已关闭: unknown')
    })

    it('should include action label in error', () => {
      expect(() => registry.assertModuleEnabled('unknown', 'test action')).toThrow('模块已关闭: unknown（test action）')
    })
  })

  describe('listModuleInfos', () => {
    it('should return module info for registered modules', () => {
      const manifest: ModuleManifest = {
        id: 'test-module',
        name: 'Test Module',
        description: 'A test module',
        category: 'stable',
        sizeLevel: 'small',
        testBadge: false,
        defaultEnabled: true,
        dependencies: [],
        entries: ['Entry 1'],
        hotkeys: ['Hotkey 1'],
      }

      registry.registerModule(manifest)

      const infos = registry.listModuleInfos()
      expect(infos).toHaveLength(1)
      expect(infos[0].id).toBe('test-module')
      expect(infos[0].name).toBe('Test Module')
      expect(infos[0].entries).toEqual(['Entry 1'])
      expect(infos[0].hotkeys).toEqual(['Hotkey 1'])
    })
  })

  describe('runResidualScan', () => {
    it('should pass when no disabled modules', () => {
      const result = registry.runResidualScan()
      expect(result.ok).toBe(true)
      expect(result.violations).toHaveLength(0)
    })
  })
})

// Import type for the manifest
import type { ModuleManifest } from '../shared/types.js'
