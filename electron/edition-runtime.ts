import { app, BrowserWindow, webContents } from 'electron'
import type { Edition } from './edition-session.js'
import { bindApplicationSession } from './application-admission.js'
import { beginApplicationHandoff } from './application-handoff-state.js'



const SAVE_BUDGET_MS = 10000
const QUIT_BUDGET_MS = 20000
let ready = false
let isBusy: () => boolean = () => true
let activation: (() => void | boolean | Promise<void | boolean>) | undefined
let isStarting = () => false
let pendingHandoff: Promise<boolean> | undefined
let pendingQuit: Promise<boolean> | undefined

const HANDOFF_SAVE_SCRIPT = `(() => {
  const waiting = [];
  const event = new CustomEvent('sidekick:before-handoff', {
    cancelable: true,
    detail: { waitUntil: promise => waiting.push(Promise.resolve(promise)), suppressPrompts: true },
  });
  const accepted = window.dispatchEvent(event);
  return Promise.allSettled(waiting).then(results => accepted && results.every(result => result.status === 'fulfilled'));
})()`

async function withinBudget<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); timer.unref?.() }),
    ])
  } finally { clearTimeout(timer) }
}

async function saveWindows(): Promise<boolean> {
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && !window.webContents.isDestroyed() && !!window.webContents.getURL())
  const saved = await Promise.allSettled(windows.map(async window => {
    const accepted = await window.webContents.executeJavaScript(HANDOFF_SAVE_SCRIPT, true)
    if (!accepted) throw new Error('Window handoff save was not accepted')
  }))
  for (const result of saved) if (result.status === 'rejected') console.warn('[EditionSession] Window save failed', result.reason)
  return saved.every(result => result.status === 'fulfilled')
}

function cancelWindowHandoff(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed() || !window.webContents.getURL()) continue
    void window.webContents.executeJavaScript("window.dispatchEvent(new Event('sidekick:cancel-handoff'))", true)
      .catch(error => console.warn('[EditionSession] Window save cancellation failed', error))
  }
}

/** Keep editors frozen until a verified restore is queued or explicitly cancelled. */
export async function prepareDataRestoreHandoff(): Promise<() => void> {
  if (!ready || isBusy() || pendingHandoff) throw new Error('应用正在执行其他操作，请稍后重试导入。')
  const release = beginApplicationHandoff()
  let complete: (accepted: boolean) => void = () => {}
  const lease = new Promise<boolean>(resolve => { complete = resolve })
  pendingHandoff = lease
  let resumed = false
  const cancel = () => {
    if (pendingHandoff && pendingHandoff !== lease) return
    cancelWindowHandoff()
  }
  const resume = () => {
    if (resumed) return
    resumed = true
    cancel(); release(); complete(false)
    if (pendingHandoff === lease) pendingHandoff = undefined
  }
  const saving = Promise.all([saveWindows()])
  try {
    const [saved] = await withinBudget(saving, SAVE_BUDGET_MS, 'Application restore save timed out')
    if (!saved || isBusy()) throw new Error('更改尚未全部保存，导入已暂停；请保存后重试。')
    return resume
  } catch (error) {
    resume()
    void saving.finally(cancel).catch(() => {})
    throw error
  }
}

export async function preparePermissionHandoff(): Promise<boolean> {
  if (!ready || isBusy() || pendingHandoff) return false
  const release = beginApplicationHandoff()
  try {
    return await withinBudget(saveWindows(), SAVE_BUDGET_MS, 'Window handoff save timed out') && !isBusy()
  } catch (error) {
    console.warn('[EditionSession] Permission handoff preparation failed', error)
    return false
  } finally { cancelWindowHandoff(); release() }
}

export function quitPermissionHandoff(canQuit: () => boolean = () => true): Promise<boolean> {
  if (!ready || isBusy() || !canQuit()) return Promise.resolve(false)
  return performHandoff(canQuit)
}

export function quitForBackup(beforeQuit: () => Promise<void>): Promise<boolean> {
  if (!ready || isBusy() || pendingHandoff) return Promise.resolve(false)
  return performHandoff(() => true, beforeQuit)
}

function performHandoff(canQuit: () => boolean = () => true, beforeQuit: () => Promise<void> = async () => {}): Promise<boolean> {
  if (pendingHandoff) return pendingHandoff
  const task = (async () => {
    const release = beginApplicationHandoff()
    let accepted = false
    try {
      if (isBusy() || !canQuit()) return false
      if (!await withinBudget(saveWindows(), SAVE_BUDGET_MS, 'Application handoff save timed out')) return false
      if (isBusy() || !canQuit()) return false
      await beforeQuit()
      accepted = await quitAfterHandoff()
      return accepted
    } finally {
      if (!accepted) {
        cancelWindowHandoff()
      }
      release()
    }
  })()
  pendingHandoff = task
  void task.finally(() => { if (pendingHandoff === task) pendingHandoff = undefined }).catch(() => {})
  return task
}

/** Await completed shutdown; prevented quit events may be asynchronous preparation. */
export function quitAfterHandoff(): Promise<boolean> {
  if (pendingQuit) return pendingQuit
  const task = new Promise<boolean>((resolve, reject) => {
    const observed = new Set<Electron.WebContents>()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      app.removeListener('web-contents-created', onCreated)
      app.removeListener('quit', onQuit)
      for (const contents of observed) contents.removeListener('will-prevent-unload', onUnload)
    }
    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      if (!accepted) (app as unknown as { isQuitting: boolean }).isQuitting = false
      resolve(accepted)
    }
    const onUnload = (event: Electron.Event) => event.preventDefault()
    const observe = (contents: Electron.WebContents) => {
      if (observed.has(contents)) return
      observed.add(contents)
      contents.on('will-prevent-unload', onUnload)
    }
    const onCreated = (_event: Electron.Event, contents: Electron.WebContents) => observe(contents)
    const onQuit = () => finish(true)
    app.on('web-contents-created', onCreated)
    app.once('quit', onQuit)
    for (const contents of webContents.getAllWebContents()) observe(contents)
    timer = setTimeout(() => finish(false), QUIT_BUDGET_MS)
    timer.unref?.()
    try { app.quit() }
    catch (error) { settled = true; cleanup(); reject(error) }
  })
  pendingQuit = task
  void task.finally(() => { if (pendingQuit === task) pendingQuit = undefined }).catch(() => {})
  return task
}

export function bindEditionActivation(callback: () => void | boolean | Promise<void | boolean>, starting: () => boolean = () => false): void { activation = callback; isStarting = starting }
export function markEditionReady(): void { ready = true }

export async function startEditionSession(edition: Edition, busy: () => boolean): Promise<boolean> {
  isBusy = busy
  return bindApplicationSession(edition, {
    state: () => !ready || isStarting() ? 'starting' : busy() ? 'busy' : 'ready',
    onActivate: async () => {
      if (activation) return activation()
      const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
      if (!window) return !ready
      window.show(); window.focus()
      return true
    },
    onQuit: async () => {
      try { return await performHandoff() }
      catch (error) { console.warn('[EditionSession] Cooperative handoff did not finish', error); return false }
    },
  })
}
