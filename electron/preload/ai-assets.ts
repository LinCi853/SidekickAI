import { ipcRenderer } from 'electron'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AiAssetsAPI } from '../shared/ai-assets.types.js'

export const aiAssetsApi: { aiAssets: AiAssetsAPI } = {
  aiAssets: {
    freezeTargets: () => ipcRenderer.invoke(ipc.ASSET_FREEZE_TARGETS),
    focusPage: id => ipcRenderer.invoke(ipc.ASSET_FOCUS_PAGE, id),
    observe: observation => ipcRenderer.invoke(ipc.ASSET_OBSERVE, observation),
    details: id => ipcRenderer.invoke(ipc.ASSET_DETAILS, id),
    usage: sourceId => ipcRenderer.invoke(ipc.ASSET_USAGE, sourceId),
    attachments: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENTS, id),
    openAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_OPEN, id),
    exportAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_EXPORT, id),
    retryAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_RETRY, id),
    suggestions: () => ipcRenderer.invoke(ipc.ASSET_SUGGESTIONS),
    searchConversations: query => ipcRenderer.invoke(ipc.ASSET_SEARCH, query),
  },
}
