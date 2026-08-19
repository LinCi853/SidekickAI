// electron/preload/modules.ts — 模块管理 Preload API（window.electron.modules）

import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import type { ModuleInfo, ModuleStateChangedPayload } from '../shared/types.js'

export const modulesApi = {
  /** 模块管理（插件市场 / 开发者选项） */
  modules: {
    list: (): Promise<ModuleInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.MODULE_LIST),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MODULE_SET_ENABLED, { id, enabled }),
    clearData: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.MODULE_CLEAR_DATA, { id }),
    onStateChanged: (callback: (payload: ModuleStateChangedPayload) => void): (() => void) => {
      const handler = (_e: unknown, payload: ModuleStateChangedPayload) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.MODULE_STATE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.MODULE_STATE_CHANGED, handler)
    },
  },
}
