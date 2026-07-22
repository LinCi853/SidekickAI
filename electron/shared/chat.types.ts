// chat.types.ts — 对话持久化 / 自定义 AI 提供商 / 提示词模板 / 痕迹记录
// 由 shared/types.ts 拆分而来；类型定义内容保持原样，仅做物理拆分。

// ============================================================================
// 提示词模板（明输入明注入）
// ============================================================================

/** 提示词模板：可注入到 AI 平台输入框的预设文本 */
export interface PromptTemplate {
  /** 唯一标识（UUID） */
  id: string
  /** 模板标题 */
  title: string
  /**
   * 提示词内容。支持占位符 {{body}}（当前输入框内容）。
   * {{body}} 在内容中的位置决定了输入内容的注入位置。
   */
  content: string
  /** 分类（可选，用于分组展示） */
  category?: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 局内快捷键（需求 2.5：如 "Ctrl+Shift+1"，空表示无快捷键） */
  hotkey?: string
}

// ============================================================================
// 自定义 AI 提供商（API 直连模式）
// ============================================================================

/** API 协议类型 */
export type AIProtocol = 'openai' | 'anthropic' | 'custom'

/** 自定义 AI 提供商配置（API Key 在主进程用 safeStorage 加密存储） */
export interface CustomAIProvider {
  /** 唯一标识（UUID） */
  id: string
  /** 显示名称 */
  name: string
  /** API 协议类型 */
  protocol: AIProtocol
  /** API 端点 URL（如 https://api.openai.com/v1/chat/completions） */
  apiEndpoint: string
  /** API 密钥（主进程内加密存储；渲染进程拿到的为明文，仅用于展示星号） */
  apiKey: string
  /** 默认模型（主模型） */
  model: string
  /** 可选：备选模型列表（同一供应商下可切换使用的多个模型） */
  alternativeModels?: string[]
  /** 可选：温度（0~2） */
  temperature?: number
  /** 可选：最大 token */
  maxTokens?: number
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 最近一次打开使用的时间戳（AppSwitcher 排序依据；null=从未使用，排在最后） */
  lastUsedAt?: number | null
  /** v0.5.2 R-5：TTS 是否启用（复用本供应商的 endpoint/apiKey 合成语音） */
  ttsEnabled?: boolean
  /** v0.5.2 R-5：TTS 模型名（如 'tts-1'） */
  ttsModel?: string
  /** v0.5.2 R-5：STT 是否启用（复用本供应商的 endpoint/apiKey 识别语音） */
  sttEnabled?: boolean
  /** v0.5.2 R-5：STT 模型名（如 'whisper-1'） */
  sttModel?: string
}

/** 创建/更新 Provider 时传入的载荷（不含加密细节与自动维护字段） */
export type CustomAIProviderInput = Omit<CustomAIProvider, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>

// ============================================================================
// 对话持久化（SQLite）
// ============================================================================

/** 对话来源类型：webview=网页抓取 / api=API 直连 */
export type ConversationSourceType = 'webview' | 'api'

/** 对话会话 */
export interface Conversation {
  id: string
  /** 关联的 Profile id 或 Provider id */
  sourceId: string
  /** 来源类型 */
  sourceType: ConversationSourceType
  /** 会话标题 */
  title: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
  /** 对话发生时的页面 URL（仅 webview 来源有值；用于"启动时打开最近对话"功能） */
  url?: string
}

/** 消息角色 */
export type ChatRole = 'user' | 'assistant' | 'system'

/** 对话消息 */
export interface ChatMessage {
  id: string
  /** 所属会话 id */
  conversationId: string
  /** 消息角色 */
  role: ChatRole
  /** 消息内容 */
  content: string
  /** token 数（可选） */
  tokens?: number
  /** 创建时间戳 */
  createdAt: number
  /** 内容哈希（去重用，conversation_id+role+content 的 sha256） */
  contentHash?: string
  /** 是否由 webview 自动抓取入库（需求 6：区分自动抓取与 API 直连） */
  autoGrabbed?: boolean
}

/** 窗口操作痕迹动作类型 */
export type WindowTraceAction =
  | 'create'
  | 'close'
  | 'maximize'
  | 'unmaximize'
  | 'minimize'
  | 'restore'
  | 'tab_switch'
  | 'pin_toggle'
  | 'show'
  | 'hide'

/** 窗口操作痕迹记录 */
export interface WindowTrace {
  id: string
  windowId: string
  action: WindowTraceAction
  /** JSON 详情（如 tabId、bounds 等） */
  detail?: string
  timestamp: number
}

/** 登录痕迹记录（用于记录 webview 平台登录信息，便于会话恢复研究） */
export interface LoginTrace {
  id: string
  profileId: string
  /** 平台标识（aiPlatformId 或域名） */
  platform?: string
  /** 登录 URL */
  loginUrl?: string
  /** 登录时间戳 */
  loginTime: number
  /** 会话数据（JSON，含 cookie 摘要等） */
  sessionData?: string
}

/** 发送对话请求的载荷 */
export interface ChatSendPayload {
  /** 会话 id（不存在则主进程自动创建） */
  conversationId?: string
  /** Provider id（API 模式必填） */
  providerId: string
  /** 用户消息内容 */
  message: string
  /** 关联的 Profile id（webview 抓取模式用） */
  profileId?: string
  /** 会话标题（首次创建时使用） */
  title?: string
  /** 系统提示词：发送给 API 的 system message（可选，由 chat 窗口配置注入） */
  systemPrompt?: string
  /** 需求 10：记录文本模板前缀（保存 assistant 消息前附加，支持 {{time}} {{tag}} 占位符） */
  recordTextPrefix?: string
  /** 需求 10：记录文本模板后缀 */
  recordTextSuffix?: string
  /** 需求 10：模板占位符 {{tag}} 的替换值（通常为 chatConfig.title 或 provider 名） */
  tag?: string
}

/** 流式推送的块 */
export interface ChatStreamChunk {
  /** 会话 id */
  conversationId: string
  /** 本次推送的文本增量 */
  delta: string
  /** 是否结束 */
  done: boolean
}
