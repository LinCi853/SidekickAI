import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModuleStateRecord } from './module-state-store.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  states: new Map<string, ModuleStateRecord>(),
  meta: new Map<string, string>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => path.join(fixture.directory, 'SidekickAI.exe') } }))
vi.mock('./store-paths.js', () => ({ isPortableMode: () => false }))
vi.mock('./module-state-store.js', () => ({
  getModuleState: (id: string) => fixture.states.get(id) ?? null,
  saveModuleState: vi.fn((state: ModuleStateRecord) => fixture.states.set(state.id, state)),
  isLargeModuleInstalledByManifestFile: vi.fn(() => false),
  getAppSettingsTable: () => fixture.meta,
}))
vi.mock('./app-settings-store.js', () => ({ applyInstallConfigOptions: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.states.clear()
  fixture.meta.clear()
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-whiteboard-seed-'))
})

afterEach(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))

it.each([undefined, false, true])('ignores obsolete whiteboard choices while applying installation options (enabled=%s)', async enabled => {
  const { seedFromInstallConfig } = await import('./install-config-seed.js')
  const { applyInstallConfigOptions } = await import('./app-settings-store.js')
  const { saveModuleState, isLargeModuleInstalledByManifestFile } = await import('./module-state-store.js')
  const existing = enabled === undefined ? undefined
    : { id: 'whiteboard', enabled, installed: true, clearedAt: 42, updatedAt: 1 }
  if (existing) fixture.states.set(existing.id, existing)
  fixture.meta.set('installConfigHash', 'previous-installation-configuration')
  fs.writeFileSync(path.join(fixture.directory, 'install-config.json'), JSON.stringify({
    schemaVersion: 2, modules: { whiteboard: { enabled: false } }, options: { autoLaunch: true },
  }))

  seedFromInstallConfig()

  expect(fixture.states.get('whiteboard')).toEqual(existing)
  expect(saveModuleState).not.toHaveBeenCalled()
  expect(isLargeModuleInstalledByManifestFile).not.toHaveBeenCalled()
  expect(applyInstallConfigOptions).toHaveBeenCalledWith({ autoLaunch: true })
  expect(fixture.meta.get('installConfigHash')).toMatch(/^[a-f0-9]{64}$/)
  seedFromInstallConfig()
  expect(applyInstallConfigOptions).toHaveBeenCalledTimes(1)
})
