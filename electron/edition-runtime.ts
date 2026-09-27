import { app, BrowserWindow, dialog, webContents } from 'electron'
import { acquireEditionSession, editionSessionEndpoint, type Edition } from './edition-session.js'

let ready = false

async function flushBeforeHandoff(): Promise<boolean> {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const saved = await Promise.race([
        window.webContents.executeJavaScript("window.dispatchEvent(new Event('sidekick:before-handoff', { cancelable: true }))", true),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('保存窗口响应超时')), 10000) }),
      ])
      if (!saved) throw new Error('窗口中的更改未能保存')
    } catch (error) {
      await dialog.showMessageBox({ type: 'warning', title: '暂时无法切换版本', message: '请先处理当前窗口的保存问题，再继续操作。', detail: String(error), buttons: ['继续编辑'] })
      return false
    } finally { clearTimeout(timer) }
  }
  return true
}

function quitAfterHandoff(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const observed = new Set<Electron.WebContents>()
    const windows = BrowserWindow.getAllWindows()
    let settled = false
    const cleanup = () => {
      app.removeListener('web-contents-created', onCreated)
      app.removeListener('before-quit', onPreventableQuit)
      app.removeListener('will-quit', onPreventableQuit)
      app.removeListener('quit', onQuit)
      for (const contents of observed) contents.removeListener('will-prevent-unload', onUnload)
      for (const window of windows) window.removeListener('close', onPreventableQuit)
    }
    const finish = (accepted: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      if (!accepted) (app as unknown as { isQuitting: boolean }).isQuitting = false
      resolve(accepted)
    }
    const onPreventableQuit = (event: Electron.Event) => {
      // Inspect the final decision after all listeners have run.
      queueMicrotask(() => { if (event.defaultPrevented) finish(false) })
    }
    const onUnload = (event: Electron.Event) => {
      // Unlike close, preventing this event allows unloading. Never override a veto.
      queueMicrotask(() => { if (!event.defaultPrevented) finish(false) })
    }
    const observe = (contents: Electron.WebContents) => {
      if (observed.has(contents)) return
      observed.add(contents)
      contents.on('will-prevent-unload', onUnload)
    }
    const onCreated = (_event: Electron.Event, contents: Electron.WebContents) => observe(contents)
    const onQuit = () => finish(true)
    app.on('web-contents-created', onCreated)
    app.on('before-quit', onPreventableQuit)
    app.on('will-quit', onPreventableQuit)
    app.once('quit', onQuit)
    for (const contents of webContents.getAllWebContents()) observe(contents)
    for (const window of windows) window.on('close', onPreventableQuit)
    try { app.quit() }
    catch (error) { cleanup(); reject(error) }
  })
}

export function markEditionReady(): void { ready = true }

export async function startEditionSession(edition: Edition, busy: () => boolean): Promise<boolean> {
  const result = await acquireEditionSession({
    edition,
    endpoint: editionSessionEndpoint(process.env.SIDEKICK_TEST_SESSION, edition, app.getPath('userData')),
    executable: app.getPath('exe'),
    state: () => busy() ? 'busy' : ready ? 'ready' : 'starting',
    onActivate: () => {
      const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
      if (window) { window.show(); window.focus() }
    },
    onQuit: async () => {
      if (busy() || !await flushBeforeHandoff() || busy()) return false
      return quitAfterHandoff()
    },
  })
  if (!result.acquired) {
    if (!result.reason.includes('已切换到现有窗口')) dialog.showErrorBox('当前版本未启动', result.reason)
    app.exit(0)
    return false
  }
  return true
}
