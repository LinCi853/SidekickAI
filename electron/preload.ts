// electron/preload.ts — 主 UI 窗口的 Preload 脚本
//
// 通过 contextBridge 暴露类型安全的 API 到渲染进程（window.electron）。
// contextIsolation 始终开启，不直接暴露 ipcRenderer，仅暴露最小必要接口。

import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './shared/types.js'
import { profileApi } from './preload/profile.js'
import { windowApi } from './preload/window.js'
import { voiceApi } from './preload/voice.js'
import { hotkeyApi } from './preload/hotkey.js'
import { chatApi } from './preload/chat.js'
import { promptApi } from './preload/prompt.js'
import { browserApi } from './preload/browser.js'
import { appSettingsApi } from './preload/appSettings.js'
import { notesApi } from './preload/notes.js'
import { whiteboardApi } from './preload/whiteboard.js'
import { freezeApi } from './preload/freeze.js'
import { bootstrapApi, setupDomSideEffects } from './preload/bootstrap.js'
import { modulesApi } from './preload/modules.js'

const api: ElectronAPI = {
  ...profileApi,
  ...windowApi,
  ...voiceApi,
  ...hotkeyApi,
  ...chatApi,
  ...promptApi,
  ...browserApi,
  ...appSettingsApi,
  ...notesApi,
  ...whiteboardApi,
  ...freezeApi,
  ...bootstrapApi,
  ...modulesApi,
  plugins: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const handler = (_e: unknown, ...args: unknown[]) => callback(...args)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
  },
}

// 暴露到 window.electron
contextBridge.exposeInMainWorld('electron', api)

// DOM 副作用（平台标记、窗口形状属性、点击日志等）
setupDomSideEffects()
