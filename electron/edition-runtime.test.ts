import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const fixture = vi.hoisted(() => ({
  app: null as any, windows: [] as any[], contents: [] as any[], callbacks: null as any,
  bind: vi.fn(), show: vi.fn(), warning: vi.fn(), error: vi.fn(),
}))
vi.mock('electron', () => ({
  get app() { return fixture.app },
  BrowserWindow: { getAllWindows: () => fixture.windows },
  webContents: { getAllWebContents: () => fixture.contents },
  dialog: { showMessageBox: fixture.warning, showErrorBox: fixture.error },
}))
vi.mock('./application-admission.js', () => ({ bindApplicationSession: fixture.bind }))
vi.mock('./utils/focus-manager.js', () => ({ show: fixture.show }))
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true } })
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function window() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: (): string => 'file:///application/index.html', executeJavaScript: vi.fn().mockResolvedValue(true) })
  fixture.contents.push(contents)
  const current = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents, show: vi.fn(), focus: vi.fn() })
  fixture.windows.push(current)
  return current
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fixture.windows = []; fixture.contents = []
  window()
  fixture.app = Object.assign(new EventEmitter(), { quit: vi.fn(() => fixture.app.emit('quit')) })
  fixture.bind.mockImplementation(async (_edition: string, callbacks: unknown) => { fixture.callbacks = callbacks; return true })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('data restore preparation', () => {
  const cancellations = (host: any) => host.webContents.executeJavaScript.mock.calls.filter((call: string[]) => call[0].includes("new Event('sidekick:cancel-handoff')")).length

  it('awaits every editor and holds the lease until its idempotent release without exiting', async () => {
    const first = deferred<boolean>(), second = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(first.promise)
    const other = window(); other.webContents.executeJavaScript.mockReturnValueOnce(second.promise)
    const runtime = await start()
    const { isApplicationHandoff } = await import('./application-handoff-state.js')
    fixture.app.relaunch = vi.fn()
    let complete = false
    const preparing = runtime.prepareDataRestoreHandoff().then(release => { complete = true; return release })
    await settle()
    expect(isApplicationHandoff()).toBe(true)
    await expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow()
    expect(fixture.windows[0].webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(other.webContents.executeJavaScript).toHaveBeenCalledOnce()
    first.resolve(true); await settle()
    expect(complete).toBe(false)
    second.resolve(true)
    const release = await preparing
    expect(isApplicationHandoff()).toBe(true)
    expect(cancellations(other)).toBe(0)
    await expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow()
    expect(await runtime.preparePermissionHandoff()).toBe(false)
    const beforeQuit = vi.fn()
    expect(await runtime.quitForBackup(beforeQuit)).toBe(false)
    const overlappingQuit = runtime.quitPermissionHandoff()
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.app.relaunch).not.toHaveBeenCalled()
    release(); release()
    expect(await overlappingQuit).toBe(false)
    expect(isApplicationHandoff()).toBe(false)
    expect(cancellations(other)).toBe(1)
    expect(beforeQuit).not.toHaveBeenCalled()
    const retryRelease = await runtime.prepareDataRestoreHandoff()
    retryRelease()
  })

  it.each(['rejected', 'refused'])('keeps every editor open after a %s save and allows another attempt', async mode => {
    const first = deferred<boolean>(), second = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(first.promise)
    const other = window(); other.webContents.executeJavaScript.mockReturnValueOnce(second.promise)
    const runtime = await start()
    const { isApplicationHandoff } = await import('./application-handoff-state.js')
    let complete = false
    const preparing = runtime.prepareDataRestoreHandoff().finally(() => { complete = true })
    const failed = expect(preparing).rejects.toThrow()
    if (mode === 'rejected') first.reject(new Error('Disk unavailable'))
    else first.resolve(false)
    await settle()
    expect(complete).toBe(false)
    second.resolve(true); await failed; await settle()
    expect(isApplicationHandoff()).toBe(false)
    expect(cancellations(other)).toBeGreaterThan(0)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    const retryRelease = await runtime.prepareDataRestoreHandoff()
    retryRelease()
  })

  it('cancels after the common timeout and cancels a late save without exiting', async () => {
    const saved = deferred<boolean>()
    const host = fixture.windows[0]
    host.webContents.executeJavaScript.mockReturnValueOnce(saved.promise)
    const runtime = await start()
    const { isApplicationHandoff } = await import('./application-handoff-state.js')
    const failed = expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow('Application restore save timed out')
    await vi.advanceTimersByTimeAsync(10000); await failed
    expect(isApplicationHandoff()).toBe(false)
    const cancelled = cancellations(host)
    expect(cancelled).toBeGreaterThan(0)
    saved.resolve(true); await settle()
    expect(cancellations(host)).toBeGreaterThan(cancelled)
    expect(fixture.app.quit).not.toHaveBeenCalled()
  })

  it('does not unfreeze a newer restore when a timed-out save completes late', async () => {
    const saved = deferred<boolean>(), host = fixture.windows[0]
    host.webContents.executeJavaScript.mockReturnValueOnce(saved.promise)
    const runtime = await start()
    const { isApplicationHandoff } = await import('./application-handoff-state.js')
    const failed = expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow('Application restore save timed out')
    await vi.advanceTimersByTimeAsync(10000); await failed
    const release = await runtime.prepareDataRestoreHandoff()
    const cancelled = cancellations(host)
    try {
      saved.resolve(true); await settle()
      expect(isApplicationHandoff()).toBe(true)
      expect(cancellations(host)).toBe(cancelled)
      expect(fixture.app.quit).not.toHaveBeenCalled()
    } finally { release() }
  })

  it('rejects unavailable sessions and a busy transition during saving', async () => {
    const runtime = await import('./edition-runtime.js')
    await expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow()
    expect(fixture.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled()
    let busy = true
    await start(() => busy)
    await expect(runtime.prepareDataRestoreHandoff()).rejects.toThrow()
    busy = false
    const saved = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(saved.promise)
    const preparing = runtime.prepareDataRestoreHandoff()
    busy = true; saved.resolve(true)
    await expect(preparing).rejects.toThrow()
    const { isApplicationHandoff } = await import('./application-handoff-state.js')
    expect(isApplicationHandoff()).toBe(false)
    expect(fixture.app.quit).not.toHaveBeenCalled()
  })
})

async function start(busy: () => boolean = () => false) {
  const runtime = await import('./edition-runtime.js')
  await runtime.startEditionSession('community', busy)
  runtime.markEditionReady()
  return runtime
}

describe('awaited application handoff', () => {
  it('leaves windows without a document outside renderer saving and cancellation', async () => {
    const auxiliary = window()
    auxiliary.webContents.getURL = () => ''
    auxiliary.webContents.executeJavaScript.mockReturnValue(new Promise(() => {}))
    const runtime = await start()
    expect(await runtime.preparePermissionHandoff()).toBe(true)
    expect(auxiliary.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(await fixture.callbacks.onQuit()).toBe(true)
    expect(auxiliary.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(fixture.app.quit).toHaveBeenCalledOnce()
  })

  it('saves windows concurrently and waits for every window even if another fails', async () => {
    const first = deferred<boolean>(); const second = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(first.promise)
    const other = window(); other.webContents.executeJavaScript.mockReturnValueOnce(second.promise)
    await start()
    let completed = false
    const handoff = fixture.callbacks.onQuit().then((value: boolean) => { completed = true; return value })
    await settle()
    expect(fixture.windows[0].webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(other.webContents.executeJavaScript).toHaveBeenCalledOnce()
    first.reject(new Error('Disk unavailable')); await settle()
    expect(completed).toBe(false)
    second.resolve(true)
    expect(await handoff).toBe(false)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.warning).not.toHaveBeenCalled(); expect(fixture.error).not.toHaveBeenCalled()
  })

  it('uses one ten-second budget across hung windows', async () => {
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(new Promise(() => {}))
    window().webContents.executeJavaScript.mockReturnValueOnce(new Promise(() => {}))
    await start()
    const handoff = fixture.callbacks.onQuit()
    await vi.advanceTimersByTimeAsync(10000)
    expect(await handoff).toBe(false)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.warning).not.toHaveBeenCalled()
  })

  it('keeps awaiting an asynchronous before-quit preparation instead of reporting a veto', async () => {
    const runtime = await start()
    fixture.app.quit.mockImplementation(() => {
      const preparing = event(); preparing.preventDefault(); fixture.app.emit('before-quit', preparing)
      setTimeout(() => fixture.app.emit('quit'), 100)
    })
    let completed = false
    const handoff = runtime.quitAfterHandoff().then(value => { completed = true; return value })
    await vi.advanceTimersByTimeAsync(50)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(await handoff).toBe(true)
    expect(fixture.app.listenerCount('quit')).toBe(0)
  })

  it('bounds an unresolved quit and removes observers before a retry', async () => {
    const runtime = await start(); fixture.app.quit.mockImplementation(() => {})
    const handoff = runtime.quitAfterHandoff()
    await vi.advanceTimersByTimeAsync(20000)
    expect(await handoff).toBe(false)
    expect(fixture.app.listenerCount('web-contents-created')).toBe(0)
    expect(fixture.contents[0].listenerCount('will-prevent-unload')).toBe(0)
    fixture.app.quit.mockImplementation(() => fixture.app.emit('quit'))
    expect(await runtime.quitAfterHandoff()).toBe(true)
  })

  it('suppresses guest unload prompts during a verified application handoff', async () => {
    const runtime = await start()
    const guest = new EventEmitter()
    const unload = event()
    fixture.app.quit.mockImplementation(() => {
      fixture.app.emit('web-contents-created', event(), guest)
      guest.emit('will-prevent-unload', unload)
      fixture.app.emit('quit')
    })
    expect(await runtime.quitAfterHandoff()).toBe(true)
    expect(unload.defaultPrevented).toBe(true)
    expect(guest.listenerCount('will-prevent-unload')).toBe(0)
  })

  it('merges repeated shutdown requests while saving', async () => {
    const save = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(save.promise)
    await start()
    const first = fixture.callbacks.onQuit(); const second = fixture.callbacks.onQuit()
    await settle()
    expect(fixture.windows[0].webContents.executeJavaScript).toHaveBeenCalledOnce()
    save.resolve(true)
    expect(await first).toBe(true); expect(await second).toBe(true)
    expect(fixture.app.quit).toHaveBeenCalledOnce()
  })

  it('rechecks the busy state and permission request validity after asynchronous saving', async () => {
    let busy = false
    const runtime = await start(() => busy)
    const save = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(save.promise)
    const preparing = runtime.preparePermissionHandoff()
    busy = true; save.resolve(true)
    expect(await preparing).toBe(false)
    busy = false
    let valid = true
    const retry = deferred<boolean>()
    fixture.windows[0].webContents.executeJavaScript.mockReturnValueOnce(retry.promise)
    const quitting = runtime.quitPermissionHandoff(() => valid)
    await settle(); valid = false; retry.resolve(true)
    expect(await quitting).toBe(false)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    expect(fixture.warning).not.toHaveBeenCalled()
  })

  it('uses awaited renderer contributions with synchronous compatibility', async () => {
    const runtime = await start()
    let script = ''
    fixture.windows[0].webContents.executeJavaScript.mockImplementation(async (source: string) => {
      script = source
      const renderer = new EventTarget()
      renderer.addEventListener('sidekick:before-handoff', value => {
        const custom = value as Event & { detail: { waitUntil(promise: Promise<void>): void } }
        custom.detail.waitUntil(Promise.resolve())
      })
      class SaveEvent extends Event { constructor(type: string, public options: any) { super(type, options) } get detail() { return this.options.detail } }
      return new Function('window', 'CustomEvent', `return ${source}`)(renderer, SaveEvent)
    })
    expect(await runtime.preparePermissionHandoff()).toBe(true)
    expect(script).toContain('sidekick:cancel-handoff')
    expect(fixture.windows[0].webContents.executeJavaScript.mock.calls[0][0]).toContain('Promise.allSettled')
  })

  it('delegates retired-window activation to the application UI binding', async () => {
    const runtime = await start(); fixture.windows = []
    const recreate = vi.fn().mockResolvedValue(true)
    runtime.bindEditionActivation(recreate)
    expect(await fixture.callbacks.onActivate()).toBe(true)
    expect(recreate).toHaveBeenCalledOnce()
  })
})
