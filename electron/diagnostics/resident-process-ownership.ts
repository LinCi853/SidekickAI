import { BrowserWindow, webContents } from 'electron'

/** Only a renderer wholly owned by one unfocused window may use local idle. */
export function backgroundWindowForProcess(pid: number): BrowserWindow | null {
  let owner: BrowserWindow | null = null
  try {
    const matches = webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getOSProcessId() === pid)
    if (!matches.length) return null
    for (const contents of matches) {
      const window = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)
      if (!window || window.isDestroyed() || window.isFocused() || (owner && owner !== window)) return null
      owner = window
    }
    return owner
  } catch { return null }
}
