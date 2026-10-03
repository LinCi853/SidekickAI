import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  acquire: vi.fn(), endpoint: vi.fn(), prepare: vi.fn(), intent: vi.fn(), exit: vi.fn(), spawn: vi.fn(), close: vi.fn(), activate: vi.fn(), packaged: false,
}))
vi.mock('electron', () => ({ app: { getPath: () => 'E:/application/SidekickAI.exe', exit: fixture.exit, get isPackaged() { return fixture.packaged } } }))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
vi.mock('./edition-session.js', () => ({ acquireEditionSession: fixture.acquire, editionSessionEndpoint: fixture.endpoint, prepareEditionSession: fixture.prepare, applicationSessionIntent: fixture.intent }))
vi.mock('./runtime-mode.js', () => ({ pluginPreview: null }))

const originalArguments = [...process.argv]
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.argv = ['SidekickAI.exe']
  fixture.packaged = false
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: 'E:/packaged/resources' })
  fixture.acquire.mockResolvedValue({ acquired: true, server: { close: fixture.close } })
  fixture.prepare.mockResolvedValue(undefined)
  fixture.endpoint.mockReturnValue('isolated-session')
  fixture.intent.mockReturnValue({ intent: 'ordinary' })
  fixture.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() })
})
afterEach(() => {
  process.argv = originalArguments
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  else delete (process as { resourcesPath?: string }).resourcesPath
  vi.restoreAllMocks()
})

describe('application admission before persistent initialization', () => {
  it.each([false, true])('uses a packaged helper location only for packaged applications %s', async packaged => {
    fixture.packaged = packaged
    const admission = await import('./application-admission.js')
    await admission.reserveApplicationSession('community')
    expect(fixture.acquire.mock.calls[0][0].resourcesPath).toBe(packaged ? process.resourcesPath : undefined)
    expect(fixture.endpoint).toHaveBeenCalledWith(process.env.SIDEKICK_TEST_SESSION, 'community', '', packaged ? process.resourcesPath : undefined)
  })
  it.each([['--export-user-data'], ['--export-user-data', '--hidden']])('arbitrates malformed export arguments %j before loading data', async (...args) => {
    process.argv.push(...args)
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    const prepare = vi.fn().mockResolvedValue(true)
    await admission.initializeApplication('community', load, prepare)
    expect(prepare).toHaveBeenCalledOnce()
    expect(fixture.acquire).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledOnce()
  })
  it('does not load stores while ownership is still being negotiated', async () => {
    let resolve!: (value: unknown) => void
    fixture.acquire.mockImplementation(() => new Promise(done => { resolve = done }))
    const admission = await import('./application-admission.js')
    const load = vi.fn().mockResolvedValue(undefined)
    const pending = admission.initializeApplication('community', load)
    await vi.waitFor(() => expect(fixture.acquire).toHaveBeenCalledOnce())
    expect(load).not.toHaveBeenCalled()
    expect(fixture.acquire.mock.calls[0][0].state()).toBe('starting')
    resolve({ acquired: true, server: { close: fixture.close } })
    await pending
    expect(load).toHaveBeenCalledOnce()
  })

  it('binds live callbacks to the reserved owner without acquiring twice', async () => {
    const admission = await import('./application-admission.js')
    await admission.reserveApplicationSession('community')
    const quit = vi.fn().mockResolvedValue(true)
    const activate = vi.fn().mockResolvedValue(true)
    await admission.bindApplicationSession('community', { state: () => 'ready', onActivate: activate, onQuit: quit })
    const options = fixture.acquire.mock.calls[0][0]
    expect(options.state()).toBe('ready')
    expect(await options.onActivate()).toBe(true)
    expect(await options.onQuit()).toBe(true)
    expect(activate).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
    expect(fixture.acquire).toHaveBeenCalledOnce()
  })

  it('exits an activated follower before any data initialization', async () => {
    fixture.acquire.mockResolvedValue({ acquired: false, outcome: 'activated', reason: 'activated' })
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    await admission.initializeApplication('concept', load)
    expect(load).not.toHaveBeenCalled()
    expect(fixture.exit).toHaveBeenCalledWith(0)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('restarts only the verified target returned by admission', async () => {
    fixture.acquire.mockResolvedValue({ acquired: false, outcome: 'redirected', reason: 'restart', targetExecutable: 'E:/community/SidekickAI.exe', targetEdition: 'community' })
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    await admission.initializeApplication('concept', load)
    expect(load).not.toHaveBeenCalled()
    expect(fixture.spawn).toHaveBeenCalledWith('E:/community/SidekickAI.exe', [], expect.objectContaining({ detached: true, windowsHide: true }))
  })

  it('preserves installation intent before the selected application opens stores', async () => {
    const requestId = 'a'.repeat(64)
    fixture.intent.mockReturnValue({ intent: 'installation', requestId })
    const admission = await import('./application-admission.js')
    await admission.initializeApplication('concept', vi.fn())
    expect(fixture.acquire).toHaveBeenCalledWith(expect.objectContaining({ intent: 'installation', requestId }))
  })

  it('keeps export helpers outside main application arbitration', async () => {
    process.argv.push('--export-user-data', 'E:/private/request.json')
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    const prepare = vi.fn()
    await admission.initializeApplication('community', load, prepare)
    expect(load).toHaveBeenCalledOnce()
    expect(prepare).not.toHaveBeenCalled()
    expect(fixture.acquire).not.toHaveBeenCalled()
  })

  it('does not initialize a rejected privileged candidate', async () => {
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    await admission.initializeApplication('community', load, async () => false)
    expect(fixture.acquire).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('fails closed without initializing data when ownership cannot be obtained', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fixture.acquire.mockResolvedValue({ acquired: false, outcome: 'unavailable', reason: 'identity unavailable' })
    const admission = await import('./application-admission.js')
    const load = vi.fn()
    await admission.initializeApplication('community', load)
    expect(load).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})
