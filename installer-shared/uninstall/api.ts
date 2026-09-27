/** Tauri bridge for the shared uninstall protocol. */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  UNINSTALL_EVENT,
  type UninstallAccepted,
  type UninstallApi,
  type UninstallEvent,
} from './protocol'

export interface UninstallTransport {
  invoke: typeof invoke
  listen: typeof listen
}

/** Readiness is local to the renderer; it does not add an IPC command. */
export function createUninstallApi(transport: UninstallTransport = { invoke, listen }): UninstallApi {
  const callbacks = new Set<(event: UninstallEvent) => void>()
  const errorListeners = new Set<(error: unknown) => void>()
  let subscription: { ready: Promise<void>; dispose: () => void } | null = null

  const ensureSubscription = () => {
    if (subscription) return subscription
    let disposed = false
    let unlisten: UnlistenFn | undefined
    const current = {
      ready: Promise.resolve(),
      dispose: () => {
        disposed = true
        unlisten?.()
      },
    }
    current.ready = Promise.resolve().then(() => transport.listen<UninstallEvent>(UNINSTALL_EVENT, (event) => {
      if (!disposed) for (const callback of callbacks) callback(event.payload)
    })).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    // Observe rejection even if initialization has not yet awaited readiness.
    void current.ready.catch((error: unknown) => {
      if (!disposed) for (const callback of errorListeners) callback(error)
    })
    subscription = current
    return current
  }

  const whenReady = async () => {
    if (!callbacks.size) throw new Error('卸载进度连接尚未建立，请重试。')
    const current = ensureSubscription()
    await current.ready
    if (subscription !== current || !callbacks.size) throw new Error('卸载进度连接已断开，请重试。')
  }

  return {
    onCloseRequested: (callback) => {
      let disposed = false
      let off: UnlistenFn | undefined
      void transport.listen<void>('installer-close-requested', () => { if (!disposed) callback() })
        .then(unlisten => { if (disposed) unlisten(); else off = unlisten })
        .catch(error => { if (!disposed) for (const listener of errorListeners) listener(error) })
      return () => { disposed = true; off?.() }
    },
    openLog: (logPath) => transport.invoke('open_operation_log', { logPath }),
    getInfo: () => transport.invoke('uninstall_get_info'),
    scan: (request) => transport.invoke('uninstall_scan', request === undefined ? undefined : { request }),
    start: async (request) => {
      await whenReady()
      return transport.invoke<UninstallAccepted>('uninstall_start', { request })
    },
    cancel: (operationId) => transport.invoke('uninstall_cancel', { operationId }),
    close: () => transport.invoke('uninstall_close'),
    chooseBackupPath: (format, suggestedName) => transport.invoke('uninstall_choose_backup_path', { format, suggestedName }),
    onEvent: (callback) => {
      callbacks.add(callback)
      ensureSubscription()
      return () => {
        callbacks.delete(callback)
        if (!callbacks.size) {
          subscription?.dispose()
          subscription = null
        }
      }
    },
    whenReady,
    onEventError: (callback) => {
      errorListeners.add(callback)
      return () => { errorListeners.delete(callback) }
    },
  }
}

export const uninstallApi = createUninstallApi()
