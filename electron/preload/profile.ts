import { ipcRenderer } from 'electron'
import { IPC_CHANNELS, type Profile } from '../shared/types.js'

export const profileApi = {
  // Profile 管理
  profile: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_LIST),
    create: (partial: Partial<Profile>) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_CREATE, partial),
    update: (id: string, patch: Partial<Profile>) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_UPDATE, id, patch),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_DELETE, id),
    duplicate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_DUPLICATE, id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_REORDER, orderedIds),
    /** 监听 Profile 被任意窗口更新后的广播（跨窗口同步） */
    onUpdated: (callback: (data: { id: string; profile: Profile }) => void) => {
      const handler = (_e: unknown, data: { id: string; profile: Profile }) => callback(data)
      ipcRenderer.on(IPC_CHANNELS.PROFILE_UPDATED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_UPDATED, handler)
    },
    /** 监听 Profile 新建/复制后的广播（跨窗口同步新增卡片） */
    onCreated: (callback: (profile: Profile) => void) => {
      const handler = (_e: unknown, profile: Profile) => callback(profile)
      ipcRenderer.on(IPC_CHANNELS.PROFILE_CREATED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_CREATED, handler)
    },
    /** 监听 Profile 删除后的广播（跨窗口同步移除卡片） */
    onDeleted: (callback: (profileId: string) => void) => {
      const handler = (_e: unknown, profileId: string) => callback(profileId)
      ipcRenderer.on(IPC_CHANNELS.PROFILE_DELETED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_DELETED, handler)
    },
    /** 监听 Profile 拖拽排序后的广播（跨窗口同步顺序） */
    onReordered: (callback: (orderedIds: string[]) => void) => {
      const handler = (_e: unknown, orderedIds: string[]) => callback(orderedIds)
      ipcRenderer.on(IPC_CHANNELS.PROFILE_REORDERED, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.PROFILE_REORDERED, handler)
    },
  },
  // 设备预设
  presets: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_LIST),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_GET, id),
    save: (preset: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_SAVE, preset),
    delete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_DELETE, id),
    update: (id: string, patch: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PRESETS_UPDATE, id, patch),
  },
  // 指纹脚本（单页架构：渲染进程取脚本注入 webview）
  fingerprint: {
    getScript: (profileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FINGERPRINT_GET_SCRIPT, profileId),
  },
}
