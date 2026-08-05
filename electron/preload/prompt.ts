import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type PromptTemplate } from '../shared/types.js'

export const promptApi = {
  // 提示词模板（明输入明注入）
  prompt: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_LIST),
    save: (template: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_SAVE, template),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_DELETE, id),
    exportPrompts: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_EXPORT),
    importPrompts: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_IMPORT),
    openWindow: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_OPEN_WINDOW),
    // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
    requestInject: (template: PromptTemplate) => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_INJECT_REQUEST, template),
  },
  // 注入历史管理（需求 2：注入预览 + Jaccard 去重）
  injection: {
    log: (record: unknown) => ipcRenderer.invoke(IPC_CHANNELS.INJECTION_LOG, record),
    findSimilar: (text: string, limit?: number, threshold?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.INJECTION_FIND_SIMILAR, text, limit, threshold),
  },
  // 提示词注入请求（主→主窗口渲染：提示词库窗口请求注入激活 webview）
  // 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中组合后注入
  onPromptInjectRequest: (callback: (template: PromptTemplate) => void) => {
    const handler = (_e: unknown, template: PromptTemplate) => callback(template)
    ipcRenderer.on(IPC_CHANNELS.PROMPT_INJECT_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROMPT_INJECT_REQUEST, handler)
  },
  // 提示词注入结果（主→提示词库窗口渲染：注入成功/失败回传）
  onPromptInjectResult: (
    callback: (result: { success: boolean; platformName?: string }) => void,
  ) => {
    const handler = (
      _e: unknown,
      result: { success: boolean; platformName?: string },
    ) => callback(result)
    ipcRenderer.on(IPC_CHANNELS.PROMPT_INJECT_RESULT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PROMPT_INJECT_RESULT, handler)
  },
  // 主窗口渲染 → 主进程：回传注入结果（主进程再转发到提示词库窗口）
  sendPromptInjectResult: (result: { success: boolean; platformName?: string }) => {
    ipcRenderer.send(IPC_CHANNELS.PROMPT_INJECT_RESULT, result)
  },
}
