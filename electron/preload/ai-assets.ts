import { ipcRenderer } from 'electron'
import { IPC_CHANNELS as ipc } from '../shared/ipc-channels.js'
import type { AiAssetsAPI } from '../shared/ai-assets.types.js'

export const aiAssetsApi: { aiAssets: AiAssetsAPI } = {
  aiAssets: {
    collectionIssues: () => ipcRenderer.invoke(ipc.ASSET_COLLECTION_ISSUES),
    onCollectionIssuesChanged: callback => {
      const handler = (_event: unknown, issues: import('../shared/ai-assets.types.js').AssetCollectionIssue[]) => callback(issues)
      ipcRenderer.on(ipc.ASSET_COLLECTION_ISSUES_CHANGED, handler)
      return () => ipcRenderer.removeListener(ipc.ASSET_COLLECTION_ISSUES_CHANGED, handler)
    },
    freezeTargets: () => ipcRenderer.invoke(ipc.ASSET_FREEZE_TARGETS),
    focusPage: (id, expectedProfileId) => ipcRenderer.invoke(ipc.ASSET_FOCUS_PAGE, id, expectedProfileId),
    observe: observation => ipcRenderer.invoke(ipc.ASSET_OBSERVE, observation),
    details: id => ipcRenderer.invoke(ipc.ASSET_DETAILS, id),
    usage: (sourceId, conversationId) => ipcRenderer.invoke(ipc.ASSET_USAGE, sourceId, conversationId),
    graph: id => ipcRenderer.invoke(ipc.ASSET_GRAPH, id),
    selectBranch: (id, nodeId) => ipcRenderer.invoke(ipc.ASSET_SELECT_BRANCH, id, nodeId),
    summaries: () => ipcRenderer.invoke(ipc.ASSET_SUMMARIES),
    recordView: (id, eventId) => ipcRenderer.invoke(ipc.ASSET_VIEW, id, eventId),
    deleteConversation: id => ipcRenderer.invoke(ipc.ASSET_DELETE_CONVERSATION, id),
    deleteMessage: id => ipcRenderer.invoke(ipc.ASSET_DELETE_MESSAGE, id),
    deleteSelection: (kind, ids) => ipcRenderer.invoke(ipc.ASSET_DELETE_SELECTION, kind, ids),
    renameConversation: (id, title) => ipcRenderer.invoke(ipc.ASSET_RENAME_CONVERSATION, id, title),
    cleanupRecords: () => ipcRenderer.invoke(ipc.ASSET_CLEANUP_RECORDS),
    settings: () => ipcRenderer.invoke(ipc.ASSET_SETTINGS),
    updateSettings: changes => ipcRenderer.invoke(ipc.ASSET_SETTINGS_UPDATE, changes),
    onSettingsChanged: callback => {
      const handler = (_event: unknown, settings: import('../shared/ai-assets.types.js').AssetSettings) => callback(settings)
      ipcRenderer.on(ipc.ASSET_SETTINGS_CHANGED, handler)
      return () => ipcRenderer.removeListener(ipc.ASSET_SETTINGS_CHANGED, handler)
    },
    openExternal: url => ipcRenderer.invoke(ipc.ASSET_OPEN_EXTERNAL, url),
    copyText: content => ipcRenderer.invoke(ipc.ASSET_COPY_TEXT, content),
    previewCode: (content, language) => ipcRenderer.invoke(ipc.ASSET_PREVIEW_CODE, content, language),
    attachments: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENTS, id),
    openAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_OPEN, id),
    exportAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_EXPORT, id),
    retryAttachment: id => ipcRenderer.invoke(ipc.ASSET_ATTACHMENT_RETRY, id),
    suggestions: () => ipcRenderer.invoke(ipc.ASSET_SUGGESTIONS),
    searchConversations: query => ipcRenderer.invoke(ipc.ASSET_SEARCH, query),
  },
}
