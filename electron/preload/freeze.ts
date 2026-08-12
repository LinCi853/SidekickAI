// electron/preload/freeze.ts — 页面冻结 Preload 桥
//
// 暴露冻结相关 API 到渲染进程（window.electron.freeze）。
// 防撤回保险：渲染层在 webview attach 后注册到主进程冻结注册表，
// 用户触发冻结时主进程先抓取对话入库再 Debugger.pause。

import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

export const freezeApi = {
  freeze: {
    /** 注册 webview 到冻结注册表（webview attach 后调用） */
    registerWebview: (payload: {
      tabId: string
      windowId: string
      profileId: string
      webContentsId: number
    }) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_REGISTER_WEBVIEW, payload),
    /** 冻结指定 tab（先抓取对话入库再 pause，返回冻结结果 + 快照） */
    freezeTab: (payload: {
      tabId: string
      profileId: string
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
    }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_TAB, payload) as Promise<{
        frozen: boolean
        snapshot: {
          pairs: Array<{ user: string; assistant: string }>
          title: string
          url: string
          scrapedAt: number
        } | null
      }>,
    /** 恢复指定 tab（解除冻结） */
    resume: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_RESUME, tabId),
    /** 彻底分离调试器 */
    detach: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_DETACH, tabId),
    /** 查询冻结状态 */
    status: (tabId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_STATUS, tabId) as Promise<'idle' | 'attached' | 'frozen'>,
    /** 主→渲染：冻结状态变化推送 */
    onStateChanged: (
      callback: (payload: { tabId: string; state: 'idle' | 'attached' | 'frozen' }) => void,
    ) => {
      const handler = (
        _e: unknown,
        payload: { tabId: string; state: 'idle' | 'attached' | 'frozen' },
      ) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.FREEZE_STATE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FREEZE_STATE_CHANGED, handler)
    },
    /** 主→渲染：窗口 move/resize 后请求重新上报冻结 tab 的 webview 位置 */
    onSyncRect: (callback: (payload: { tabIds: string[] }) => void) => {
      const handler = (_e: unknown, payload: { tabIds: string[] }) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.FREEZE_SYNC_RECT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FREEZE_SYNC_RECT, handler)
    },
    /** 渲染→主：上报 webview 位置（窗口内 CSS 像素 + dpr） */
    reportRect: (payload: {
      tabId: string
      rect: { x: number; y: number; width: number; height: number }
      dpr: number
    }) => ipcRenderer.send(IPC_CHANNELS.FREEZE_REPORT_RECT, payload),
  },
}
