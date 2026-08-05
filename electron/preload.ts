// electron/preload.ts — 主 UI 窗口的 Preload 脚本
//
// 通过 contextBridge 暴露类型安全的 API 到渲染进程（window.electron）。
// contextIsolation 始终开启，不直接暴露 ipcRenderer，仅暴露最小必要接口。

import { contextBridge } from 'electron'
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
import { bootstrapApi, setupDomSideEffects } from './preload/bootstrap.js'

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
  ...bootstrapApi,
}

// 暴露到 window.electron
contextBridge.exposeInMainWorld('electron', api)

// DOM 副作用（平台标记、窗口形状属性、点击日志等）
setupDomSideEffects()
