import { ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

const DROP_LIFETIME_MS = 60_000
let pendingDrop: { token: Promise<string>; capturedAt: number } | null = null
let installed = false

function nativePaths(event: DragEvent): string[] {
  if (!event.isTrusted || !event.dataTransfer?.types.includes('Files')) return []
  const paths: string[] = []
  for (const file of Array.from(event.dataTransfer.files)) {
    if (!(file instanceof File)) continue
    try {
      const filename = webUtils.getPathForFile(file)
      if (filename) paths.push(filename)
    } catch { /* Non-native files do not carry filesystem authority. */ }
  }
  return paths
}

async function capture(paths: string[], requireFallback = false): Promise<string> {
  const prepared = await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE)
  if (!prepared || typeof prepared.nonce !== 'string' || !prepared.nonce) throw new Error('File drop authorization is unavailable')
  if (requireFallback && prepared.fallbackAllowed !== true) throw new Error('File viewing is unavailable in this window')
  const captured = await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_CAPTURE, { nonce: prepared.nonce, paths })
  if (!captured || typeof captured.token !== 'string' || !captured.token) throw new Error('File drop authorization was refused')
  return captured.token
}

async function consume(): Promise<string> {
  const current = pendingDrop
  pendingDrop = null
  if (!current || Date.now() - current.capturedAt > DROP_LIFETIME_MS) throw new Error('A recent native file drop is required')
  return current.token
}

export async function readDroppedFiles(): Promise<Array<{ filename: string; dataUrl: string; mime: string; size: number }>> {
  return ipcRenderer.invoke(IPC_CHANNELS.WEBVIEW_FILE_DROP, { token: await consume() })
}

export async function openDroppedFiles(): Promise<void> {
  await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, { token: await consume() })
}

/** Captures native files in the isolated world before host UI event handlers run. */
export function installFileDropCapture(mode: 'host' | 'guest'): () => void {
  if (installed || window.top !== window) return () => {}
  installed = true
  const finishers = new Set<() => void>()
  let fallbackAllowed = false, preparation = 0
  const dragenter = (event: DragEvent) => {
    if (mode !== 'guest' || !event.isTrusted || !event.dataTransfer?.types.includes('Files')) return
    const current = ++preparation
    fallbackAllowed = false
    void ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_PREPARE).then(prepared => {
      if (current === preparation) fallbackAllowed = prepared?.fallbackAllowed === true
    }).catch(() => {})
  }
  const afterPageHandlers = (event: DragEvent, handler: () => void) => {
    const finish = (current: Event) => { if (current === event) { cleanup(); handler() } }
    const cleanup = () => { window.removeEventListener(event.type, finish); clearTimeout(timer); finishers.delete(cleanup) }
    window.addEventListener(event.type, finish)
    const timer = setTimeout(cleanup, 0)
    finishers.add(cleanup)
  }
  const dragover = (event: DragEvent) => {
    if (mode !== 'guest' || !fallbackAllowed || !event.isTrusted || !event.dataTransfer?.types.includes('Files')) return
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
    const allowedForDrop = fallbackAllowed
    fallbackAllowed = false
    preparation++
    if (!allowedForDrop) return
    afterPageHandlers(event, () => {
      if (event.defaultPrevented || event.composedPath().some(target => target instanceof HTMLInputElement && target.type === 'file')) return
      event.preventDefault()
      void capture(paths, true).then(token => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_FILE_DROP_OPEN, { token }))
        .catch(error => console.warn('[file-drop] Unable to open dropped files:', error))
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
    fallbackAllowed = false
    preparation++
    installed = false
  }
}
