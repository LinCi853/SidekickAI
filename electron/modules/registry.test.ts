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
    const state = await import('../store/module-state-store.js')
    vi.mocked(state.getModuleState).mockReset().mockReturnValue(null)
    vi.mocked(state.isLargeModuleInstalledByManifestFile).mockReset().mockReturnValue(true)
    vi.mocked(state.saveModuleState).mockReset()
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

  it.each([
    { profile: 'new', installed: undefined, enabled: true },
    { profile: 'previously omitted', installed: false, enabled: false },
    { profile: 'explicitly disabled', installed: true, enabled: false },
    { profile: 'enabled', installed: true, enabled: true },
  ])('keeps whiteboard installed for a $profile profile despite a legacy omission', async ({ installed, enabled }) => {
    const state = await import('../store/module-state-store.js')
    const { BUILTIN_MODULE_INSTALL_DATA } = await import('./builtin-module-data.js')
    const existing = installed === undefined ? null
      : { id: 'whiteboard', installed, enabled, clearedAt: 42, updatedAt: 1 }
    const records = new Map<string, import('../store/module-state-store.js').ModuleStateRecord>()
    if (existing) records.set(existing.id, existing)
    vi.mocked(state.getModuleState).mockImplementation(id => records.get(id) ?? null)
    vi.mocked(state.saveModuleState).mockImplementation(record => { records.set(record.id, record) })
    vi.mocked(state.isLargeModuleInstalledByManifestFile).mockReturnValue(false)
    const init = vi.fn()
    registry.registerModule({ ...BUILTIN_MODULE_INSTALL_DATA.find(module => module.id === 'whiteboard')!, init })

    await registry.initEnabledModules()

    expect(registry.isModuleInstalled('whiteboard')).toBe(true)
    expect(registry.isModuleEnabled('whiteboard')).toBe(enabled)
    expect(records.get('whiteboard')).toEqual(expect.objectContaining({
      id: 'whiteboard', installed: true, enabled, clearedAt: existing?.clearedAt ?? 0,
    }))
    expect(state.isLargeModuleInstalledByManifestFile).not.toHaveBeenCalled()
    if (installed !== true) expect(state.saveModuleState).toHaveBeenCalledWith(expect.objectContaining({
      id: 'whiteboard', installed: true, enabled, clearedAt: existing?.clearedAt ?? 0,
    }))
    expect(init).toHaveBeenCalledTimes(enabled ? 1 : 0)

    expect(await registry.setModuleEnabled('whiteboard', true)).toEqual({ ok: true })
    expect(registry.isModuleEnabled('whiteboard')).toBe(true)
    expect(records.get('whiteboard')).toEqual(expect.objectContaining({
      id: 'whiteboard', installed: true, enabled: true, clearedAt: existing?.clearedAt ?? 0,
    }))
  })

  it('uses promoted defaults for new users while preserving an existing disabled choice', async () => {
    const state = await import('../store/module-state-store.js')
    vi.mocked(state.getModuleState).mockImplementation(id => id === 'voice'
      ? { id, enabled: false, installed: true, clearedAt: 0, updatedAt: 1 } : null)
    const voice = vi.fn(), browser = vi.fn()
    for (const [id, init] of [['voice', voice], ['browser', browser]] as const) registry.registerModule({
      id, name: id, description: id, category: 'stable', sizeLevel: 'small', testBadge: false,
      defaultEnabled: true, dependencies: [], entries: [], hotkeys: [], init,
    })
    await registry.initEnabledModules()
    expect(registry.isModuleEnabled('voice')).toBe(false)
    expect(voice).not.toHaveBeenCalled()
    expect(registry.isModuleEnabled('browser')).toBe(true)
    expect(browser).toHaveBeenCalledOnce()
  })
})

// Import type for the manifest
import type { ModuleManifest } from '../shared/types.js'
