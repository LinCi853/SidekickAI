import type { ChatRole, ConversationSourceType } from './chat.types.js'

export type AssetMessageStatus = 'streaming' | 'complete' | 'withdrawn' | 'retained' | 'stopped' | 'failed'
export interface AssetObservedMessage {
  key: string
  role: ChatRole
  content: string
  reasoning?: string
  status?: AssetMessageStatus
}
export interface AssetObservation {
  conversationKey: string
  previousConversationKey?: string
  title: string
  url?: string
  messages: AssetObservedMessage[]
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
  freezeTargets(): Promise<Array<{ tabId: string; profileId: string; windowId: string; webContentsId: number; title: string; url: string }>>
  focusPage(webContentsId: number): Promise<boolean>
  observe(observation: AssetObservation): Promise<{ conversationId: string }>
  details(conversationId: string): Promise<AssetMessageDetail[]>
  usage(sourceId?: string): Promise<AssetTextUsage>
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
}

export interface AssetNavigationEvent extends AssetNavigation { revision: number }

export interface AssetSource {
  id: string
  type: ConversationSourceType
}
