// chat.api.ts — Chat / AIProvider / AIPlatform / Prompt / InjectionHistory 接口

import type {
  Conversation,
  ConversationSourceType,
  ChatMessage,
  ChatSendPayload,
  ChatStreamChunk,
  CustomAIProvider,
  CustomAIProviderInput,
  PromptTemplate,
  WindowTrace,
  LoginTrace,
} from '../chat.types.js'
import type { ChatWindowConfig } from '../window.types.js'
import type { AIPlatform } from '../profile.types.js'

/** 对话持久化接口（SQLite） */
export interface ChatAPI {
  /** 列出会话（按 sourceId 过滤；不传则列出全部） */
  listConversations(sourceId?: string): Promise<Conversation[]>
  /** 创建会话 */
  createConversation(sourceId: string, sourceType: ConversationSourceType, title: string, url?: string): Promise<Conversation>
  /** 查询指定来源最近一条带 URL 的对话 URL（用于"启动时打开最近对话"） */
  getLastConversationUrl(sourceId: string): Promise<string | null>
  /** 删除会话（连同消息级联删除） */
  deleteConversation(id: string): Promise<void>
  /** 列出会话消息（按时间升序） */
  listMessages(conversationId: string): Promise<ChatMessage[]>
  /** 保存消息并智能合并（需求 5：Jaccard 相似度 ≥ 0.85 时更新而非新增） */
  saveMessageWithMerge(
    msg: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): Promise<{ merged: boolean; messageId: string; skipped: boolean }>
  /** webview 抓取入库后通知主进程广播给其他窗口（HistoryView 订阅以实时刷新侧边栏） */
  notifyConversationPersisted(sourceId: string): Promise<void>
  /** 订阅入库广播事件（主进程 → 所有窗口）。返回取消订阅函数。 */
  onConversationPersisted(callback: (payload: { sourceId: string }) => void): () => void
  /** 全文搜索消息内容 */
  search(query: string): Promise<Array<ChatMessage & { conversationTitle: string }>>
  /** 发送消息：API 直连调用 + 流式推送，返回会话 id */
  send(payload: ChatSendPayload): Promise<{ conversationId: string; userMessageId: string }>
  /** 取消正在进行的流式请求 */
  cancel(conversationId: string): Promise<void>
  /** 监听流式分块推送（主进程 → 渲染层） */
  onStreamChunk(callback: (chunk: ChatStreamChunk) => void): () => void
  /** 监听流式结束 */
  onStreamEnd(callback: (info: { conversationId: string; ok: boolean; error?: string }) => void): () => void
  /** 记录登录痕迹 */
  logLoginTrace(trace: Omit<LoginTrace, 'id' | 'loginTime'> & Partial<Pick<LoginTrace, 'id' | 'loginTime'>>): Promise<void>
  /** 列出窗口操作痕迹（按时间倒序，limit 默认 200） */
  listWindowTraces(windowId?: string, limit?: number): Promise<WindowTrace[]>
  /** 列出登录痕迹 */
  listLoginTraces(profileId?: string): Promise<LoginTrace[]>
  /** token 用量统计（可选按 sourceId 过滤） */
  getUsageStats(sourceId?: string): Promise<{ totalTokens: number; todayTokens: number; todayCount: number }>
  /** 导出会话为 MD/JSON 并落盘（主进程弹保存对话框） */
  exportConversation(conversationId: string, format: 'md' | 'json'): Promise<{ ok: boolean; filePath?: string; canceled?: boolean }>
  /** 导入会话（从文件），format 支持 json/deepseek/md */
  importConversation(format: 'json' | 'deepseek' | 'md', sourceId: string): Promise<{ ok: boolean; canceled?: boolean; conversation?: Conversation }>
  /** 清空所有对话（可选按 sourceId 过滤） */
  clearConversations(sourceId?: string): Promise<{ ok: boolean; count: number }>
  /** 清空登录痕迹（可选按 profileId 过滤） */
  clearLoginTraces(profileId?: string): Promise<{ ok: boolean; count: number }>
  /** 清空窗口操作痕迹（可选按 windowId 过滤） */
  clearWindowTraces(windowId?: string): Promise<{ ok: boolean; count: number }>
  /** 清空所有使用统计与点击日志 */
  clearUsageTraces(): Promise<{ ok: boolean; count: number }>
  /** 更新消息内容 */
  updateMessage(messageId: string, updates: Partial<Pick<ChatMessage, 'content' | 'role'>>): Promise<{ ok: boolean }>
  /** 删除单条消息 */
  deleteMessage(messageId: string): Promise<{ ok: boolean }>
  /** 更新会话（标题等） */
  updateConversation(id: string, updates: { title?: string }): Promise<{ ok: boolean }>
  /** 打开历史搜索独立窗口（单例，列举所有本地保存数据） */
  openHistoryWindow(): Promise<void>
  /** 更新自定义对话脱离窗口配置（providerId/title/style） */
  updateDetachedWindow(windowId: string, config: ChatWindowConfig): Promise<void>
  /** 获取当前窗口的 chatConfig（ChatView 渲染时调用） */
  getChatConfig(windowId: string): Promise<ChatWindowConfig | null>
  /** 主进程 → 主窗口：Alt+Q 无对话窗口时，请求打开对话配置界面 */
  onRequestConfig(callback: () => void): () => void
}

/** AI 平台接口 */
export interface AIPlatformAPI {
  // 同步获取预置平台列表（无 Profile 合并），用于立即渲染兜底
  presetList(): AIPlatform[]
  // 异步获取完整列表（合并 Profile 自定义覆盖），静默更新
  list(): Promise<AIPlatform[]>
}

/** 提示词模板管理接口（明输入明注入） */
export interface PromptAPI {
  /** 读取全部模板 */
  list(): Promise<PromptTemplate[]>
  /** 新增或更新模板（按 id upsert） */
  save(template: PromptTemplate): Promise<PromptTemplate>
  /** 删除模板 */
  delete(id: string): Promise<void>
  /** 导出全部提示词为 JSON 文件（主进程弹保存对话框 + 写文件） */
  exportPrompts(): Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>
  /** 导入提示词 JSON 文件（主进程弹打开对话框 + 读文件 + 合并入库） */
  importPrompts(): Promise<{ ok: boolean; added?: number; updated?: number; canceled?: boolean; error?: string }>
  /** 打开提示词库独立窗口（单例） */
  openWindow(): Promise<void>
  /**
   * 请求注入模板到主窗口激活 webview（提示词库窗口 → 主进程 → 主窗口渲染）
   * 需求 1：传递完整 PromptTemplate，由主窗口渲染层在 webview 上下文中执行
   *        composeFinalText（读取当前输入框内容 + 剪贴板）后再注入
   */
  requestInject(template: PromptTemplate): Promise<void>
}

/** 注入历史单条记录（需求 2：注入预览 + Jaccard 去重） */
export interface InjectionRecord {
  id: string
  /** 组合后的完整注入文本（含 prefix/content/suffix） */
  composedText: string
  /** 关联的提示词模板 id（可选） */
  templateId?: string
  /** 注入目标窗口 id */
  windowId: string
  /** 注入时间戳 */
  createdAt: number
}

/** Jaccard 相似度查找结果（含相似度分数） */
export interface SimilarInjectionResult extends InjectionRecord {
  /** 与查询文本的 Jaccard 相似度（0~1） */
  similarity: number
}

/** 注入历史管理接口（需求 2：注入预览 + Jaccard 去重） */
export interface InjectionHistoryAPI {
  /** 记录一次注入 */
  log(record: Omit<InjectionRecord, 'id' | 'createdAt'>): Promise<InjectionRecord>
  /** 在最近 limit 条记录中查找与 text 相似度 ≥ threshold 的记录 */
  findSimilar(text: string, limit?: number, threshold?: number): Promise<SimilarInjectionResult[]>
}

/** 自定义 AI 提供商管理接口 */
export interface AIProviderAPI {
  list(): Promise<CustomAIProvider[]>
  create(input: CustomAIProviderInput): Promise<CustomAIProvider>
  update(id: string, patch: Partial<CustomAIProviderInput>): Promise<CustomAIProvider>
  delete(id: string): Promise<void>
  /** 测试连通性，返回 { ok, message, latencyMs } */
  test(input: CustomAIProviderInput): Promise<{ ok: boolean; message: string; latencyMs?: number }>
  /** 需求 9：自动搜索 Provider 可用模型列表（OpenAI 兼容 /v1/models） */
  listModels(input: CustomAIProviderInput): Promise<string[]>
  /**
   * 需求 9：加密导出 Provider 配置（API Key 明文包含在加密串内）。
   * @param password 加密密码
   * @param selectedIds 可选：选择性导出的 provider id 列表（不传或为空则导出全部）
   */
  exportEncrypted(password: string, selectedIds?: string[]): Promise<string>
  /** 需求 9：从加密串导入 Provider 配置（覆盖现有同 id） */
  importEncrypted(encrypted: string, password: string): Promise<{ ok: boolean; error?: string }>
  /** v0.5.2 B-4：预览导入（dry-run，返回 provider 列表 + 冲突 id，不持久化） */
  previewImport(
    encrypted: string,
    password: string,
  ): Promise<{
    ok: boolean
    error?: string
    providers?: Array<{
      id: string
      name: string
      protocol: string
      apiEndpoint: string
      model: string
      alternativeModels?: string[]
    }>
    conflictIds?: string[]
  }>
  /** v0.5.2 B-4：选择导出文件保存路径（弹出系统保存对话框，返回 .sapp 类型的文件路径） */
  selectExportPath(): Promise<string | null>
  /** v0.5.2 B-4：选择导入文件（弹出系统打开对话框，返回文件路径） */
  selectImportFile(): Promise<string | null>
  /** v0.5.2 B-4：写入加密导出文件到指定路径 */
  writeExportFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }>
  /** v0.5.2 B-4：读取导入文件内容 */
  readImportFile(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }>
}
