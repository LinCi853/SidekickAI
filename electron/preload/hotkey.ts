import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const hotkeyApi = {
  // 热键
  hotkey: {
    register: (accelerator: string, callback: () => void) => {
      const handler = (_e: unknown, acc: string) => {
        if (acc === accelerator) callback()
      }
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_TRIGGERED, handler)
      return ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_REGISTER, accelerator)
    },
    unregister: (accelerator: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_UNREGISTER, accelerator),
    isRegistered: (accelerator: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_IS_REGISTERED, accelerator),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_GET_ALL),
    set: (action: string, accelerator: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_SET, action, accelerator),
    setEnabled: (action: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_SET_ENABLED, action, enabled),
    startRecording: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_START_RECORDING),
    stopRecording: () => ipcRenderer.invoke(IPC_CHANNELS.HOTKEY_STOP_RECORDING),
    onRecordingResult: (callback: (result: { accelerator: string; reason?: string }) => void) => {
      const handler = (_e: unknown, result: { accelerator: string; reason?: string }) => callback(result)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_START_RECORDING, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_START_RECORDING, handler)
    },
    /**
     * 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前修饰键+按键组合）
     * 用于录制 UI 实时显示用户按下的组合，无需等到最终键按下。
     * @returns 取消监听函数
     */
    onRecordingPartial: (callback: (partial: { modifiers: string[]; key: string | null }) => void) => {
      const handler = (_e: unknown, partial: { modifiers: string[]; key: string | null }) => callback(partial)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_RECORDING_PARTIAL, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_RECORDING_PARTIAL, handler)
    },
    /**
     * 订阅热键管理器状态变化（主进程推送）
     * @param callback 状态：{ uiohookStarted, voiceHotkeyRegistered, voiceKeyPressed, pollingActive }
     */
    onStatus: (callback: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => callback(status)
      ipcRenderer.on(IPC_CHANNELS.HOTKEY_STATUS, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.HOTKEY_STATUS, handler)
    },
  },
  // 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行）
  onWebviewHotkey: (
    callback: (payload: {
      action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab'
      data?: unknown
    }) => void,
  ) => {
    const handler = (_e: unknown, payload: unknown) => callback(payload as Parameters<typeof callback>[0])
    ipcRenderer.on(IPC_CHANNELS.WEBVIEW_HOTKEY, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEBVIEW_HOTKEY, handler)
  },
}
