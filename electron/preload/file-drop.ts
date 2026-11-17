import { ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const DROP_LIFETIME_MS = 60_000
type DropRoute = 'preview' | 'import' | 'none'
let pendingDrop: { token: Promise<string>; capturedAt: number } | null = null
let guestRoute: DropRoute = 'none'
let installed = false

function nativePaths(event: DragEvent): string[] {
  if (!event.isTrusted || !event.dataTransfer?.types.includes('Files')) return []
  const paths: string[] = []
  for (const file of Array.from(event.dataTransfer.files)) {
    if (!(file instanceof File)) continue
    try {
      const filename = webUtils.getPathForFile(file)
      if (filename) paths.push(filename)
    } catch {
      /* Non-native files do not carry filesystem authority. */
    }
  }
  return paths
}

async function capture(paths: string[]): Promise<string> {
  const prepared = await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE)
  if (!prepared || typeof prepared.nonce !== 'string' || !prepared.nonce)
    throw new Error('File drop authorization is unavailable')
  const captured = await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE, {
    nonce: prepared.nonce,
    paths,
  })
  if (!captured || typeof captured.token !== 'string' || !captured.token)
    throw new Error('File drop authorization was refused')
  return captured.token
}

/** Ask the host once per document load; the answer decides whether page-ignored drops are handled. */
async function loadGuestRoute(): Promise<void> {
  try {
    const value = await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_CAPABILITIES)
    guestRoute =
      value?.route === 'preview' || value?.route === 'import' ? (value.route as DropRoute) : 'none'
  } catch {
    guestRoute = 'none'
  }
}

/** The page declined the drop: preview in a browser window, otherwise import into the AI page. */
async function routeGuestDrop(paths: string[]): Promise<void> {
  const route = guestRoute
  if (route === 'none') throw new Error('File drop is unavailable in this window')
  const token = await capture(paths)
  await ipcRenderer.invoke(
    route === 'preview' ? IPC_CHANNELS.LOCAL_FILE_DROP_OPEN : IPC_CHANNELS.LOCAL_FILE_DROP_IMPORT,
    { token },
  )
}

async function consume(): Promise<string> {
  const current = pendingDrop
  pendingDrop = null
  if (!current || Date.now() - current.capturedAt > DROP_LIFETIME_MS)
    throw new Error('A recent native file drop is required')
  return current.token
}

export async function readDroppedFiles(): Promise<
  Array<{ filename: string; dataUrl: string; mime: string; size: number }>
> {
  return ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_FILE_DROP, { token: await consume() })
}

export async function openDroppedFiles(): Promise<void> {
  await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, { token: await consume() })
}

/** Captures native files in the isolated world before host UI event handlers run. */
export function installFileDropCapture(mode: 'host' | 'guest'): () => void {
  if (installed || window.top !== window) return () => {}
  installed = true
  if (mode === 'guest') void loadGuestRoute()
  const finishers = new Set<() => void>()
  const afterPageHandlers = (event: DragEvent, handler: () => void) => {
    const finish = (current: Event) => {
      if (current === event) {
        cleanup()
        handler()
      }
    }
    const cleanup = () => {
      window.removeEventListener(event.type, finish)
      clearTimeout(timer)
      finishers.delete(cleanup)
    }
    window.addEventListener(event.type, finish)
    const timer = setTimeout(cleanup, 0)
    finishers.add(cleanup)
  }
  const dragenter = (event: DragEvent) => {
    if (
      mode !== 'guest' ||
      guestRoute !== 'none' ||
      !event.isTrusted ||
      !event.dataTransfer?.types.includes('Files')
    )
      return
    // The initial capability query may have raced the first drag; retry once it is needed.
    void loadGuestRoute()
  }
  const dragover = (event: DragEvent) => {
    if (
      mode !== 'guest' ||
      guestRoute === 'none' ||
      !event.isTrusted ||
      !event.dataTransfer?.types.includes('Files')
    )
      return
    afterPageHandlers(event, () => {
      if (event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    })
  }
  const drop = (event: DragEvent) => {
    if (mode === 'host' && event.isTrusted) pendingDrop = null
    const paths = nativePaths(event)
    if (!paths.length) return
    if (mode === 'host') {
      const token = capture(paths)
      pendingDrop = { token, capturedAt: Date.now() }
      void token.catch(() => {})
      return
    }
    if (guestRoute === 'none') return
    afterPageHandlers(event, () => {
      if (
        event.defaultPrevented ||
        event
          .composedPath()
          .some((target) => target instanceof HTMLInputElement && target.type === 'file')
      )
        return
      event.preventDefault()
      void routeGuestDrop(paths).catch((error) =>
        console.warn('[file-drop] Unable to route dropped files:', error),
      )
    })
  }
  window.addEventListener('dragenter', dragenter, true)
  window.addEventListener('dragover', dragover, true)
  window.addEventListener('drop', drop, true)
  return () => {
    window.removeEventListener('dragenter', dragenter, true)
    window.removeEventListener('dragover', dragover, true)
    window.removeEventListener('drop', drop, true)
    for (const cleanup of finishers) cleanup()
    pendingDrop = null
    guestRoute = 'none'
    installed = false
  }
}
