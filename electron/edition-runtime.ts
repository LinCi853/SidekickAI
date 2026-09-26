import { app, BrowserWindow, dialog, webContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { acquireEditionSession, editionSessionEndpoint, type Edition } from './edition-session.js'

let ready = false

function legacyEdition(): string | undefined {
  if (process.platform !== 'win32' || process.env.SIDEKICK_TEST_SESSION) return undefined
  const script = "$session=(Get-Process -Id " + process.pid + ").SessionId; @(Get-CimInstance Win32_Process -Filter \"Name='SidekickAI.exe' OR Name='SidekickAI-OpenSource.exe'\" | Where-Object { $_.SessionId -eq $session -and $_.ProcessId -ne " + process.pid + " -and $_.CommandLine -notmatch '--type=' } | Select-Object ExecutablePath) | ConvertTo-Json -Compress"
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim()
  if (!output) return undefined
  const parsed = JSON.parse(output)
  const processes = Array.isArray(parsed) ? parsed : [parsed]
  for (const processInfo of processes) {
    if (!processInfo.ExecutablePath) continue
    const executable = String(processInfo.ExecutablePath)
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(executable), 'resources', 'app.asar', 'package.json'), 'utf8'))
      if (['sidekick-ai', 'sidekickai-opensource'].includes(manifest.name) && manifest.editionSessionProtocol !== 1) return executable
    } catch { return executable }
  }
  return undefined
}

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
      await dialog.showMessageBox({ type: 'warning', title: '暂时无法切换版本', message: '请先处理当前窗口的保存问题，再启动联网版。', detail: String(error), buttons: ['继续编辑'] })
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
  const legacy = legacyEdition()
  if (legacy) {
    dialog.showErrorBox('请先退出旧版本', '检测到尚不支持保存交接的旧版本。请保存并退出旧版本后重试；更新两版后可自动交接。\n' + legacy)
    app.exit(0)
    return false
  }
  const result = await acquireEditionSession({
    edition,
    endpoint: editionSessionEndpoint(process.env.SIDEKICK_TEST_SESSION),
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
