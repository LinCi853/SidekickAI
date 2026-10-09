import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { __dirname as mainDirectory } from '../window-factory/paths.js'

/** Only the application document receives host capabilities, regardless of window mode. */
export function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const expected = new URL(!app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(path.join(mainDirectory, '../renderer/index.html')).href)
    return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname
      && !url.username && !url.password
  } catch { return false }
}

export function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!event?.sender || event.sender.isDestroyed() || event.sender.getType() !== 'window'
    || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererUrl(event.sender.getURL())) {
    throw new Error('此操作仅允许应用窗口调用。')
  }
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭。')
}
