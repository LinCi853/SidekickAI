import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { product } from '../packages/product-contract'

const runtime = vi.hoisted(() => ({
  packaged: true, paths: {} as Record<string, string>, ownsLock: true,
  lock: vi.fn(), login: vi.fn(), exit: vi.fn(),
}))
vi.mock('../packages/desktop-common/running-application', () => ({ duplicateVersionNotice: () => null }))
vi.mock('electron', () => ({ app: {
  get isPackaged() { return runtime.packaged },
  getPath: (name: string) => runtime.paths[name],
  setPath: (name: string, value: string) => { runtime.paths[name] = value },
  setName: vi.fn(), setAppUserModelId: vi.fn(),
  requestSingleInstanceLock: () => { runtime.lock(runtime.paths.userData); return runtime.ownsLock },
  exit: (code: number) => { runtime.exit(code); throw new Error('Process exited') },
} }))

let directory: string
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('SIDEKICK_DATA_DIR', '')
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-portable-paths-'))
  runtime.packaged = true
  runtime.ownsLock = true
  runtime.paths = { exe: path.join(directory, 'SidekickAI.exe'), appData: path.join(directory, 'roaming'), temp: directory }
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

function dualRuntime(arch: 'x64' | 'arm64') {
  const executableDirectory = path.join(directory, product.portable.runtimes[arch])
  fs.mkdirSync(executableDirectory, { recursive: true })
  fs.writeFileSync(path.join(executableDirectory, 'portable.txt'), 'SidekickAI Dual Architecture Portable Marker\n')
  fs.writeFileSync(path.join(directory, 'portable-layout.json'), JSON.stringify(product.portable))
  runtime.paths.exe = path.join(executableDirectory, 'SidekickAI.exe')
}

describe('runtime data boundaries', () => {
  it('ignores development renderer settings in a packaged app', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5199')
    await import('./runtime-environment')
    expect(runtime.paths.userData).toBe(path.join(runtime.paths.appData, 'sidekickai-opensource'))
    expect(process.env.ELECTRON_RENDERER_URL).toBeUndefined()
  })

  it.each(['x64', 'arm64'] as const)('uses the shared data directory when %s is launched directly', async arch => {
    dualRuntime(arch)
    await import('./runtime-environment')
    expect(runtime.paths.userData).toBe(path.join(directory, 'data'))
    expect(runtime.paths.sessionData).toBe(runtime.paths.userData)
    expect(runtime.lock).toHaveBeenCalledWith(path.join(directory, 'data'))
  })

  it('preserves the data location of a legacy single architecture portable', async () => {
    fs.copyFileSync(path.resolve('resources/portable.txt'), path.join(directory, 'portable.txt'))
    await import('./runtime-environment')
    expect(runtime.paths.userData).toBe(path.join(directory, 'data'))
  })

  it('accepts an explicit absolute disposable profile', async () => {
    const fixture = path.join(directory, 'fixture')
    vi.stubEnv('SIDEKICK_DATA_DIR', fixture)
    await import('./runtime-environment')
    expect(runtime.paths.userData).toBe(fixture)
  })

  it('rejects relative profiles before creating a database directory', async () => {
    vi.stubEnv('SIDEKICK_DATA_DIR', './fixture')
    await expect(import('./runtime-environment')).rejects.toThrow('absolute')
    expect(runtime.lock).not.toHaveBeenCalled()
  })

  it('rejects a corrupted dual layout without switching to another data directory', async () => {
    dualRuntime('x64')
    fs.writeFileSync(path.join(directory, 'portable-layout.json'), '{')
    await expect(import('./runtime-environment')).rejects.toThrow()
    expect(runtime.lock).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(path.dirname(runtime.paths.exe), 'data'))).toBe(false)
  })

  it('rejects an invalid portable marker', async () => {
    fs.writeFileSync(path.join(directory, 'portable.txt'), 'unrelated file')
    await expect(import('./runtime-environment')).rejects.toThrow('marker')
    expect(runtime.lock).not.toHaveBeenCalled()
  })

  it('rejects a missing dual layout instead of creating architecture-local data', async () => {
    dualRuntime('arm64')
    fs.unlinkSync(path.join(directory, 'portable-layout.json'))
    await expect(import('./runtime-environment')).rejects.toThrow('layout is missing')
    expect(runtime.lock).not.toHaveBeenCalled()
  })

  it.each([
    { edition: 'community' },
    { dataDirectory: '../shared' },
    { runtimes: { x64: 'win-unpacked', arm64: '../arm64' } },
  ])('rejects a mismatched portable layout %j', async change => {
    dualRuntime('x64')
    fs.writeFileSync(path.join(directory, 'portable-layout.json'), JSON.stringify({ ...product.portable, ...change }))
    await expect(import('./runtime-environment')).rejects.toThrow('layout does not match')
    expect(runtime.lock).not.toHaveBeenCalled()
  })

  it('keeps the same portable data after moving the complete directory', async () => {
    dualRuntime('x64')
    const old = directory
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-portable-moved-'))
    const moved = path.join(parent, '中文 portable folder')
    fs.renameSync(old, moved)
    directory = parent
    runtime.paths.exe = path.join(moved, product.portable.runtimes.x64, 'SidekickAI.exe')
    await import('./runtime-environment')
    expect(runtime.paths.userData).toBe(path.join(moved, 'data'))
    expect(fs.existsSync(old)).toBe(false)
  })

  it('does not fall back to installed data when the portable data directory cannot be created', async () => {
    dualRuntime('x64')
    fs.writeFileSync(path.join(directory, 'data'), 'occupied path')
    await expect(import('./runtime-environment')).rejects.toThrow()
    expect(runtime.lock).not.toHaveBeenCalled()
    expect(fs.existsSync(runtime.paths.appData)).toBe(false)
  })

  it('keeps development data in the selected workspace without a renderer URL', async () => {
    const { resolveRuntimePaths } = await import('./runtime-paths')
    const developmentDirectory = path.join(directory, '.app-data')
    const selected = resolveRuntimePaths({ isPackaged: false, executable: runtime.paths.exe, appData: runtime.paths.appData, developmentDirectory })
    expect(selected.mode).toBe('development')
    expect(selected.dataDirectory).toBe(developmentDirectory)
  })

  it('does not write the identity when a profile is already locked', async () => {
    dualRuntime('x64')
    runtime.ownsLock = false
    await expect(import('./runtime-environment')).rejects.toThrow('Process exited')
    expect(runtime.exit).toHaveBeenCalledWith(0)
    expect(fs.existsSync(path.join(directory, 'data', 'edition-identity.json'))).toBe(false)
  })
})
