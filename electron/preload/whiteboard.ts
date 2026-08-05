import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

export const whiteboardApi = {
  // 白板 API（v3：Excalidraw + 多白板）
  whiteboard: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_LIST),
    create: (title?: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_CREATE, title),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_RENAME, id, title),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_DELETE, id),
    getActive: () => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_GET_ACTIVE),
    setActive: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_SET_ACTIVE, id),
    getSnapshot: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_GET_SNAPSHOT, id),
    saveSnapshot: (id: string, snapshot: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT, id, snapshot),
    // 同步保存（beforeunload 兜底）
    saveSnapshotSync: (id: string, snapshot: unknown) => ipcRenderer.sendSync(IPC_CHANNELS.WHITEBOARD_SAVE_SNAPSHOT_SYNC, id, snapshot),
    // 需求 12：保存截图 dataURL 到磁盘，返回 whiteboard-asset:// 路径
    saveImage: (dataUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_SAVE_IMAGE, dataUrl),
    // 需求 12：推送截图到白板（主进程打开进阶面板 + 切 tab + 转发载荷）
    pushImage: (payload: { assetUrl: string; sourceUrl?: string; platform?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE_REQUEST, payload),
    // 主→渲染：白板窗口接收推送的截图
    onPushImage: (
      callback: (payload: { assetUrl: string; sourceUrl?: string; platform?: string }) => void,
    ) => {
      const handler = (
        _e: unknown,
        payload: { assetUrl: string; sourceUrl?: string; platform?: string },
      ) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WHITEBOARD_PUSH_IMAGE, handler)
    },
  },
}
