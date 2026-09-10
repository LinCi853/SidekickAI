// installer-tauri/src/api.ts
// 把 Tauri invoke/event 桥接成与原 Electron preload 完全一致的 window.installer 契约，
// 使 App.tsx 无需任何改动即可复用。
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { InstallerInfo, InstallOptions, ScanResult, DonePayload, InstalledConfig } from './global'

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (disposed) u()
    else unlisten = u
  })
  return () => {
    disposed = true
    if (unlisten) unlisten()
  }
}

const api = {
  getInfo: (): Promise<InstallerInfo> => invoke<InstallerInfo>('get_info'),
  scanInstallations: (): Promise<ScanResult> => invoke<ScanResult>('scan_installations'),
  browseDir: (current: string): Promise<string> => invoke<string>('browse_dir', { current }),
  saveBackupDialog: (defaultName: string): Promise<string> => invoke<string>('save_backup_dialog', { defaultName }),
  needsAdmin: (dir: string, forAllUsers: boolean): Promise<boolean> =>
    invoke<boolean>('needs_admin', { dir, forAllUsers }),
  start: (opts: InstallOptions): Promise<boolean> => invoke<boolean>('start', { opts }),
  readInstallConfig: (dir: string): Promise<InstalledConfig | null> =>
    invoke<InstalledConfig | null>('read_install_config', { dir }),
  flushConfig: (opts: InstallOptions): Promise<boolean> => invoke<boolean>('flush_config', { opts }),
  setPendingLaunch: (installDir: string, launch: boolean, showGuide: boolean): Promise<boolean> =>
    invoke<boolean>('set_pending_launch', { installDir, launch, showGuide }),
  cancel: (): Promise<boolean> => invoke<boolean>('cancel'),
  closeWindow: (): Promise<void> => invoke<void>('close_window'),
  openDir: (dir: string): Promise<void> => invoke<void>('open_dir', { dir }),

  onStatus: (cb: (msg: string) => void) => subscribe<string>('install-status', cb),
  onProgress: (cb: (p: number) => void) => subscribe<number>('install-progress', cb),
  onDone: (cb: (payload: DonePayload) => void) => subscribe<DonePayload>('install-done', cb),
  onError: (cb: (msg: string) => void) => subscribe<string>('install-error', cb)
}

;(window as unknown as { installer: typeof api }).installer = api

export default api
