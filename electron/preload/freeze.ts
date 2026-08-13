// electron/preload/freeze.ts — 页面冻结 Preload 桥
//
// 暴露冻结相关 API 到渲染进程（window.electron.freeze）。
// 防撤回保险：渲染层在 webview attach 后注册到主进程冻结注册表，
// 用户触发冻结时主进程先抓取对话入库再 Debugger.pause。

import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import type {
  FreezeActionResult,
  FreezeScrollResult,
  FreezeState,
} from '../shared/api/freeze.api.js'

export const freezeApi = {
  freeze: {
    /** 注册 webview 到冻结注册表（webview attach 后调用） */
    registerWebview: (payload: {
      tabId: string
      windowId: string
      profileId: string
      webContentsId: number
    }) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_REGISTER_WEBVIEW, payload),
    /** 冻结指定 tab（先抓取对话入库 + 提取文本层再 pause，返回冻结结果 + 快照 + 文本层） */
    freezeTab: (payload: { tabId: string; profileId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_TAB, payload) as Promise<FreezeActionResult>,
    /** 按主进程真实状态冻结或恢复 */
    toggle: (payload: { tabId: string; profileId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_TOGGLE, payload) as Promise<FreezeActionResult>,
    /** 恢复指定 tab（解除冻结） */
    resume: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_RESUME, tabId),
    /** 彻底分离调试器 */
    detach: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.FREEZE_DETACH, tabId),
    /** 查询冻结状态 */
    status: (tabId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_STATUS, tabId) as Promise<FreezeState>,
    /** 主→渲染：冻结状态变化推送 */
    onStateChanged: (
      callback: (payload: { tabId: string; state: FreezeState; revision: number }) => void,
    ) => {
      const handler = (
        _e: unknown,
        payload: { tabId: string; state: FreezeState; revision: number },
      ) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.FREEZE_STATE_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FREEZE_STATE_CHANGED, handler)
    },
    /** 渲染→主：冻结态滚轮转发（选择层滚轮 → guest compositor 滚动画面） */
    scroll: (payload: { tabId: string; x: number; y: number; deltaX: number; deltaY: number }) =>
      ipcRenderer.invoke(IPC_CHANNELS.FREEZE_SCROLL, payload) as Promise<FreezeScrollResult | null>,
    /** 渲染→主：冻结态应用内置复制（选中文本 → 主进程写系统剪贴板） */
    copyText: (text: string) => ipcRenderer.send(IPC_CHANNELS.FREEZE_COPY_TEXT, text),
  },
}
