import type { ChatMessage, ChatRole, ConversationSourceType } from './chat.types.js'

export type AssetMessageStatus = 'streaming' | 'complete' | 'withdrawn' | 'retained' | 'stopped' | 'failed'
export interface AssetObservedMessage {
  key: string
  role: ChatRole
  content: string
  reasoning?: string
  status?: AssetMessageStatus
  markdownContent?: string
  versionKey?: string
  branchIndex?: number
  branchCount?: number
}
export interface AssetObservation {
  conversationKey: string
  previousConversationKey?: string
  title: string
  url?: string
  messages: AssetObservedMessage[]
  snapshot?: boolean
  completePath?: boolean
  visitId?: string
  adapter?: string
  rejected?: AssetRejectedCapture[]
}
export interface AssetRejectedCapture { key: string; reason: string; signature: string }
export interface AssetCollectionIssue {
  webContentsId: number
  profileId: string
  profileName: string
  failures: number
  updatedAt: number
}
export interface AssetRevision {
  id: string
  messageId: string
  content: string
  reasoning: string
  status: AssetMessageStatus
  capturedAt: number
}
export interface AssetMessageDetail {
  messageId: string
  reasoning: string
  status: AssetMessageStatus
  inputCharacters: number
  reasoningCharacters: number
  outputCharacters: number
  revisions: AssetRevision[]
  markdownContent?: string
  locallyEdited?: boolean
  observations?: string[]
}
export interface AssetGraphNode extends ChatMessage {
  parentId?: string
  sourceKey: string
  versionKey: string
  branchIndex?: number
  branchCount?: number
  locallyEdited?: boolean
}
export interface AssetConversationGraph {
  nodes: AssetGraphNode[]
  path: string[]
  sourcePath: string[]
}
export interface AssetConversationSummary { conversationId: string; views: number }
export interface AssetCleanupRecord {
  id: string; createdAt: number; sourceId: string; sourceType: string; adapter: string
  reason: string; messages: number; conversations: number; apiOrigin?: string
}
export interface AssetSettings {
  sort: 'recent' | 'views'
  expandReasoning: boolean
  revisionDisplay: 'history' | 'diff'
  localShortcuts: { search: string; conversations: string; prompts: string; files: string; freeze: string; previousBranch: string; nextBranch: string }
}
export interface AssetGraphExport {
  nodes: Array<{ id: string; parentId?: string; sourceKey: string; versionKey: string; branchIndex?: number; branchCount?: number; localContent?: string }>
  selectedLeaf?: string; sourceLeaf?: string; views: number
  exclusions: Array<{ parentId?: string; sourceKey: string; versionKey: string }>
}
export interface AssetTextUsage {
  inputCharacters: number
  reasoningCharacters: number
  outputCharacters: number
  todayCharacters: number
  totalCharacters: number
}
export type AssetAttachmentStatus = 'pending' | 'saved' | 'reused' | 'failed'
export interface AssetAttachment {
  id: string
  conversationId: string
  messageId?: string
  sourceId: string
  name: string
  mimeType: string
  sourceUrl?: string
  direction: 'input' | 'output'
  status: AssetAttachmentStatus
  sha256?: string
  size?: number
  error?: string
  createdAt: number
}
export interface AssetAttachmentInput {
  conversationKey: string
  title: string
  url?: string
  messageKey?: string
  messageId?: string
  name: string
  mimeType: string
  sourceUrl?: string
  direction: 'input' | 'output'
  externalKey: string
}
export interface AssetPromptSuggestion {
  content: string
  title: string
  weight: number
  uses: number
  conversationId: string
  messageId: string
}
export interface AiAssetsAPI {
  collectionIssues(): Promise<AssetCollectionIssue[]>
  onCollectionIssuesChanged(callback: (issues: AssetCollectionIssue[]) => void): () => void
  freezeTargets(): Promise<Array<{ tabId: string; profileId: string; windowId: string; webContentsId: number; title: string; url: string }>>
  focusPage(webContentsId: number): Promise<boolean>
  observe(observation: AssetObservation): Promise<{ conversationId: string; suppressed?: boolean; messageIds?: Record<string, string> }>
  details(conversationId: string): Promise<AssetMessageDetail[]>
  usage(sourceId?: string, conversationId?: string): Promise<AssetTextUsage>
  graph(conversationId: string): Promise<AssetConversationGraph>
  selectBranch(conversationId: string, nodeId: string): Promise<AssetConversationGraph>
  summaries(): Promise<AssetConversationSummary[]>
  recordView(conversationId: string, eventId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  deleteMessage(messageId: string): Promise<void>
  renameConversation(conversationId: string, title: string): Promise<void>
  cleanupRecords(): Promise<AssetCleanupRecord[]>
  settings(): Promise<AssetSettings>
  updateSettings(changes: Partial<AssetSettings>): Promise<AssetSettings>
  onSettingsChanged(callback: (settings: AssetSettings) => void): () => void
  openExternal(url: string): Promise<void>
  copyText(content: string): Promise<void>
  previewCode(content: string, language: 'html' | 'css' | 'javascript'): Promise<{ ok: boolean; error?: string }>
  attachments(conversationId?: string): Promise<AssetAttachment[]>
  openAttachment(id: string): Promise<{ ok: boolean; error?: string }>
  exportAttachment(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  retryAttachment(id: string): Promise<{ ok: boolean; error?: string }>
  suggestions(): Promise<AssetPromptSuggestion[]>
  searchConversations(query: string): Promise<string[]>
}
export interface AssetNavigation {
  category?: 'conversations' | 'prompts' | 'files'
  focusSearch?: boolean
  freezeTabId?: string
  openSettings?: boolean
}

export interface AssetNavigationEvent extends AssetNavigation { revision: number }

export interface AssetSource {
  id: string
  type: ConversationSourceType
}
