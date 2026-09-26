import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type net from 'node:net'
import { editionSessionEndpoint, requestEdition } from './edition-session.js'

const electron = vi.hoisted(() => ({ app: null as any, windows: [] as any[], contents: [] as any[] }))
const servers: net.Server[] = []
vi.mock('electron', () => ({
  get app() { return electron.app },
  BrowserWindow: { getAllWindows: () => electron.windows },
  webContents: { getAllWebContents: () => electron.contents },
  dialog: { showMessageBox: vi.fn(), showErrorBox: vi.fn() },
}))
vi.mock('./edition-session.js', async importOriginal => {
  const original = await importOriginal<typeof import('./edition-session.js')>()
  return { ...original, acquireEditionSession: async (options: Parameters<typeof original.acquireEditionSession>[0]) => {
    const result = await original.acquireEditionSession(options)
    if (result.acquired) servers.push(result.server)
    return result
  } }
})

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}
function emitVeto() {
  const veto = event()
  electron.windows[0].webContents.emit('will-prevent-unload', veto)
  return veto
}
const send = (action: 'activate' | 'status' | 'shutdown' = 'status') => requestEdition(
  editionSessionEndpoint(process.env.SIDEKICK_TEST_SESSION),
  { protocol: 1, edition: action === 'shutdown' ? 'open-source' : 'online', action, executable: 'E:/fixture/SidekickAI-OpenSource.exe' },
)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('SIDEKICK_TEST_SESSION', randomUUID())
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScript: vi.fn().mockResolvedValue(true),
  })
  electron.contents = [contents]
  electron.windows = [Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents })]
  electron.app = Object.assign(new EventEmitter(), {
    getPath: () => 'E:/fixture/SidekickAI-OpenSource.exe', exit: vi.fn(),
    quit: vi.fn(() => {
      const before = event()
      electron.app.emit('before-quit', before)
      if (!before.defaultPrevented) setImmediate(emitVeto)
    }),
  })
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  vi.unstubAllEnvs()
})

describe('edition runtime quit cancellation', () => {
  it.each(['activate', 'shutdown'] as const)('retries %s after an asynchronous beforeunload veto', async action => {
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    expect((await send(action)).status).toBe('yielding')
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
    expect((await send(action)).status).toBe('yielding')
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
  })

  it.each(['before-quit', 'will-quit', 'close'] as const)('recovers from a canceled %s after all listeners decide', async name => {
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    electron.app.quit.mockImplementation(() => {
      const target = name === 'close' ? electron.windows[0] : electron.app
      target.once(name, (value: ReturnType<typeof event>) => value.preventDefault())
      target.emit(name, event())
    })
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
    expect(electron.app.isQuitting).toBe(false)
    expect(electron.app.listenerCount('before-quit')).toBe(0)
    expect(electron.app.listenerCount('will-quit')).toBe(0)
    expect(electron.contents[0].listenerCount('will-prevent-unload')).toBe(0)
    expect(electron.windows[0].listenerCount('close')).toBe(0)
    expect((await send('shutdown')).status).toBe('yielding')
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledTimes(2))
  })

  it.each([false, true])('observes a guest veto (created during quit: %s)', async createdDuringQuit => {
    const guest = new EventEmitter()
    if (!createdDuringQuit) electron.contents.push(guest)
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    electron.app.quit.mockImplementation(() => {
      if (createdDuringQuit) electron.app.emit('web-contents-created', event(), guest)
      setImmediate(() => guest.emit('will-prevent-unload', event()))
    })
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
    expect(guest.listenerCount('will-prevent-unload')).toBe(0)
    expect(electron.app.listenerCount('web-contents-created')).toBe(0)
  })

  it('keeps yielding when another listener permits unload or shutdown is merely slow', async () => {
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    electron.app.quit.mockImplementation(() => {
      electron.contents[0].once('will-prevent-unload', (value: ReturnType<typeof event>) => value.preventDefault())
      emitVeto()
    })
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce())
    expect((await send()).status).toBe('yielding')
    expect((await send('shutdown')).status).toBe('yielding')
    expect(electron.app.quit).toHaveBeenCalledOnce()
    electron.app.emit('quit')
    expect((await send()).status).toBe('yielding')
    expect(electron.app.listenerCount('will-quit')).toBe(0)
    expect(electron.contents[0].listenerCount('will-prevent-unload')).toBe(0)
  })

  it('preserves ownership and permits a retry after a save rejects', async () => {
    electron.contents[0].executeJavaScript.mockResolvedValue(false)
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
    expect(electron.app.quit).not.toHaveBeenCalled()
    electron.contents[0].executeJavaScript.mockResolvedValue(true)
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce())
  })

  it('does not repeat a save while a previous handoff is pending', async () => {
    let finishSave!: (saved: boolean) => void
    electron.contents[0].executeJavaScript.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => false)
    runtime.markEditionReady()
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'))
    expect((await send('shutdown')).status).toBe('yielding')
    expect(electron.contents[0].executeJavaScript).toHaveBeenCalledOnce()
    expect(electron.app.quit).not.toHaveBeenCalled()
    finishSave(false)
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
  })

  it('rechecks restore state after an asynchronous save', async () => {
    let busy = false
    let finishSave!: (saved: boolean) => void
    electron.windows[0].webContents.executeJavaScript.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    const runtime = await import('./edition-runtime.js')
    await runtime.startEditionSession('open-source', () => busy)
    runtime.markEditionReady()
    expect((await send('activate')).status).toBe('yielding')
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'))
    busy = true
    finishSave(true)
    await vi.waitFor(async () => expect((await send()).status).toBe('busy'))
    expect(electron.app.quit).not.toHaveBeenCalled()
    expect((await send('activate')).status).toBe('busy')
    expect((await send()).status).toBe('busy')
  })
})
