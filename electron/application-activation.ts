import type { BrowserWindow } from 'electron'

export function isApplicationWindowLoading(window: BrowserWindow | null): boolean {
  return !!window && !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.isLoadingMainFrame()
}

/** A successful activation requires a live renderer, not only a visible native window. */
export async function activateApplicationWindow(options: {
  current(): BrowserWindow | null
  create(): void
  show(window: BrowserWindow): unknown | Promise<unknown>
}): Promise<boolean> {
  let window = options.current()
  if (!window || window.isDestroyed()) { options.create(); window = options.current() }
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
  if (isApplicationWindowLoading(window)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      window.webContents.executeJavaScript('true'),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Application renderer did not respond')), 1000) }),
    ])
    await options.show(window)
    return !window.isDestroyed() && window.isVisible()
  } catch (error) {
    console.warn('[ApplicationActivation] Window could not respond', error)
    return false
  } finally { clearTimeout(timer) }
}
