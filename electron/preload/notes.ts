import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const notesApi = {
  // 灵感笔记 API（v2：SQLite + FTS5 + 富文本 + 分类）
  notes: {
    list: (filter?: { keyword?: string; tag?: string; pinnedOnly?: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST, filter),
    search: (keyword: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SEARCH, keyword),
    save: (input: unknown) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE, input),
    saveSync: (input: unknown) => ipcRenderer.sendSync(IPC_CHANNELS.NOTES_SAVE_SYNC, input),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_DELETE, id),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_GET_ACTIVE),
    setActive: (id: string | null) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_ACTIVE, id),
    setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_PINNED, id, pinned),
    setTags: (id: string, tags: string[]) => ipcRenderer.invoke(IPC_CHANNELS.NOTES_SET_TAGS, id, tags),
    listTags: () => ipcRenderer.invoke(IPC_CHANNELS.NOTES_LIST_TAGS),
    sendToAi: (text: string, enterToSend: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SEND_TO_AI, { text, enterToSend }),
    saveAsPrompt: (content: string, title: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE_AS_PROMPT, { content, title }),
    saveImage: (dataUrl: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.NOTES_SAVE_IMAGE, dataUrl),
    onInjectResult: (callback: (result: { success: boolean; error?: string }) => void) => {
      const handler = (_e: unknown, result: { success: boolean; error?: string }) => callback(result)
      ipcRenderer.on(IPC_CHANNELS.NOTES_INJECT_RESULT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTES_INJECT_RESULT, handler)
    },
  },
}
