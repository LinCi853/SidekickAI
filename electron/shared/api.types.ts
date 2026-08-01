// api.types.ts — IPC 接口契约（contextBridge 暴露的完整 API）
// 由 shared/types.ts 拆分而来；接口定义内容保持原样，仅做物理拆分。
// 这些接口互相引用，集中放一个文件以避免循环依赖。

import type { Profile, DevicePreset, AIPlatform } from './profile.types.js'
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
} from './chat.types.js'
import type { WindowStateData, ChatWindowConfig } from './window.types.js'
import type { BlockRule } from './block-rules.types.js'
import type { Note, NoteSaveInput } from './notes.types.js'
import type {
  WhiteboardState,
  WhiteboardMeta,
} from './whiteboard.types.js'
import type { PlatformCapabilities } from '../utils/platform-info.js'

// re-export 供渲染进程通过 shared/types 桶导出使用
export type { PlatformCapabilities }

// ============================================================================
// IPC 接口契约
// ============================================================================

/** Profile 管理接口 */
export interface ProfileAPI {
  list(): Promise<Profile[]>
  create(partial: Partial<Profile>): Promise<Profile>
  update(id: string, patch: Partial<Profile>): Promise<Profile>
  delete(id: string): Promise<void>
  duplicate(id: string): Promise<Profile>
  /** 拖拽排序：按 orderedIds 顺序重置 Profile 的 order 字段（主进程广播 PROFILE_REORDERED） */
  reorder(orderedIds: string[]): Promise<boolean>
  /** 监听 Profile 被任意窗口更新后的广播（跨窗口同步名称等字段） */
  onUpdated(callback: (data: { id: string; profile: Profile }) => void): () => void
  /** 监听 Profile 新建/复制后的广播（跨窗口同步新增卡片） */
  onCreated(callback: (profile: Profile) => void): () => void
  /** 监听 Profile 删除后的广播（跨窗口同步移除卡片、关闭相关 tab） */
  onDeleted(callback: (profileId: string) => void): () => void
  /** 监听 Profile 拖拽排序后的广播（跨窗口同步顺序，参数为新顺序的 profile id 数组） */
  onReordered(callback: (orderedIds: string[]) => void): () => void
}

/** 窗口管理接口 */
export interface WindowAPI {
  open(profileId: string): Promise<void>
  close(profileId: string): Promise<void>
  closeAll(): Promise<void>
  switchUA(profileId: string, ua: string): Promise<void>
  switchDevice(profileId: string, presetId: string): Promise<void>
  setAlwaysOnTop(profileId: string, onTop: boolean): Promise<void>
  getOpenWindowIds(): Promise<string[]>
  /**
   * 为嵌入式 webview 准备 session（单页架构专用）。
   * 设置 session 级 UA + Client Hints 拦截器，但不创建 BrowserWindow。
   * 在 <webview> 加载前调用，保证首屏即使用正确 UA。
   */
  setupSession(profileId: string): Promise<void>
}

/** 指纹脚本接口（单页架构：渲染进程通过 IPC 取脚本注入 webview） */
export interface FingerprintAPI {
  /** 获取指定 Profile 的指纹注入脚本字符串（IIFE） */
  getScript(profileId: string): Promise<string>
}

/** 窗口控制接口（操作调用方所在窗口本身：最小化/最大化/关闭/置顶） */
export interface WindowControlAPI {
  minimize(): Promise<void>
  maximizeToggle(): Promise<boolean>
  close(): Promise<void>
  setAlwaysOnTop(onTop: boolean): Promise<boolean>
  isMaximized(): Promise<boolean>
  /** 查询当前窗口的实际置顶状态（win.isAlwaysOnTop()，非持久化值） */
  isAlwaysOnTop(): Promise<boolean>
  getBounds(): Promise<{ x?: number; y?: number; width: number; height: number }>
  /** 将指定标签脱离当前窗口，弹出为独立窗口 */
  detachTab(tabId: string): Promise<void>
  /**
   * 自定义边缘拖拽 resize。
   * 渲染层在窗口边缘按下并拖动时，向主进程发送新的目标 bounds，
   * 主进程调用 win.setBounds 完成 resize。
   */
  resize(bounds: { x?: number; y?: number; width: number; height: number }): Promise<void>
  /** 切换全屏（保留接口，当前无热键绑定） */
  toggleFullscreen(): Promise<boolean>
  /**
   * 动态设置当前窗口的最小尺寸（用于 UI 比例变化时重新约束窗口尺寸）。
   * 主进程通过 BrowserWindow.setMinimumSize 设置调用方所在窗口。
   */
  setMinimumSize(width: number, height: number): Promise<void>
  /**
   * 获取当前窗口的最小尺寸（主进程 BrowserWindow.getMinimumSize）。
   * 用于 resize 拖拽时动态获取真实下限，而非硬编码。
   */
  getMinimumSize(): Promise<{ width: number; height: number }>
  /**
   * 监听最大化状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
   * 返回取消监听的函数。
   */
  onMaximizeToggled(callback: (isMaximized: boolean) => void): () => void
  /**
   * 监听全屏状态变更事件（主进程全屏切换时通知渲染层，用于移除窗口圆角）。
   * 返回取消监听的函数。
   */
  onFullscreenToggled(callback: (isFullscreen: boolean) => void): () => void
  /**
   * 监听置顶状态变更事件（主进程 webview 快捷键兜底触发时通知渲染层）。
   * 返回取消监听的函数。
   */
  onPinToggled(callback: (alwaysOnTop: boolean) => void): () => void
}

/** 窗口状态持久化接口 */
export interface WindowStateAPI {
  /** 读取窗口状态（按 windowId） */
  get(windowId: string): Promise<WindowStateData | null>
  /** 保存窗口状态（整体覆盖） */
  save(windowId: string, state: WindowStateData): Promise<void>
  /** 读取所有脱离窗口的 id 列表 */
  listDetachedWindowIds(): Promise<string[]>
  /** 删除指定窗口状态（脱离窗口关闭时清理） */
  remove(windowId: string): Promise<void>
}

/** 标签管理接口（更新标题/顺序，由渲染进程调用并触发持久化） */
export interface TabAPI {
  /** 更新标签标题 */
  updateTitle(windowId: string, tabId: string, title: string): Promise<void>
  /** 更新标签 URL */
  updateUrl(windowId: string, tabId: string, url: string): Promise<void>
  /** 更新标签首页地址 */
  updateHomeUrl(windowId: string, tabId: string, homeUrl: string): Promise<void>
}

/** 设备预设接口 */
export interface PresetsAPI {
  list(): Promise<DevicePreset[]>
  get(id: string): Promise<DevicePreset | null>
  save(preset: DevicePreset): Promise<DevicePreset>
  delete(id: string): Promise<void>
  update(id: string, patch: Partial<DevicePreset>): Promise<DevicePreset>
}

/** 测试 AI 接入返回结果 */
export interface TestAiProviderResult {
  ok: boolean
  message: string
  text?: string
}

/** 测试 TTS 接入返回结果 */
export interface TestTtsResult {
  ok: boolean
  message: string
  audioDataUrl?: string
}

/** 语音识别接口 */
export interface SttAPI {
  /** 测试 AI 接入配置连通性（设置页"测试连接"按钮调用） */
  testAi: (input: { providerId: string }) => Promise<TestAiProviderResult>
  /**
   * 强制停止当前录音（preview 客户端兜底用：主进程 keyup 丢失时由 preview 主动调）
   * @param reason 调用原因，便于日志追踪
   */
  forceStop: (reason: string) => Promise<{ ok: boolean; reason?: string }>
  /** 上报麦克风设备列表到主进程（保存到 voice-config.inputDeviceList） */
  updateInputDeviceList: (list: unknown[]) => Promise<{ ok: boolean; count?: number; reason?: string }>
  /** 请求渲染层重新枚举设备 */
  refreshInputDevices: () => Promise<{ ok: boolean }>
  /** 检查 whisper-cli 二进制是否实际存在（不依赖 cfg.downloadStatus） */
  checkCliExists: () => Promise<{ exists: boolean; path: string | null; size: number }>
  /** 检查单个 whisper 模型文件是否实际存在 */
  checkModelExists: (modelId: string) => Promise<{ exists: boolean; error?: string }>
  /** 列出磁盘上所有已下载的 whisper 模型 id 列表 */
  listDownloadedModels: () => Promise<{ ok: boolean; models: string[]; error?: string }>
}

/** 内置热键动作标识 */
export type HotkeyAction =
  | 'toggleMainWindow'
  | 'toggleDetachedWindows'
  | 'backgroundVoice'

/** 热键配置（UI 展示与持久化） */
export interface HotkeyConfig {
  action: HotkeyAction
  /** 显示名称 */
  label: string
  /** accelerator 字符串 */
  accelerator: string
  /** 是否启用（false 时热键不注册、不响应） */
  enabled: boolean
}

/** 热键接口 */
export interface HotkeyAPI {
  register(accelerator: string, callback: () => void): Promise<boolean>
  unregister(accelerator: string): Promise<void>
  isRegistered(accelerator: string): Promise<boolean>
  /** 获取全部内置热键配置（供 UI 展示） */
  getAll(): Promise<HotkeyConfig[]>
  /** 设置某个内置热键（注销旧的，注册新的并持久化；返回是否注册成功） */
  set(action: HotkeyAction, accelerator: string): Promise<boolean>
  /** 启用/禁用某个内置热键（禁用时注销，启用时注册；持久化） */
  setEnabled(action: HotkeyAction, enabled: boolean): Promise<void>
  /** 开始录制热键（主进程临时注册 globalShortcut 捕获按键组合） */
  startRecording(): Promise<boolean>
  /** 停止录制热键 */
  stopRecording(): Promise<void>
  /** 监听热键录制结果（主进程 → 渲染层：录制完成后通知） */
  onRecordingResult(callback: (result: { accelerator: string; reason?: string }) => void): () => void
  /** 订阅热键录制实时反馈（主进程 → 渲染层：每次按键时推送当前组合，用于 UI 实时显示） */
  onRecordingPartial(callback: (partial: { modifiers: string[]; key: string | null }) => void): () => void
  /** 订阅热键管理器状态变化（主进程推送：uiohook/voiceHotkey/voiceKeyPressed/polling） */
  onStatus(callback: (status: unknown) => void): () => void
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

/** 语音识别引擎模式 */
export type SttEngineMode = 'builtin' | 'ai' | 'local' | 'download'

/**
 * 麦克风/音频输入设备信息（来自 navigator.mediaDevices.enumerateDevices）。
 * - deviceId：getUserMedia / enumerateDevices 的设备 ID（每次浏览器启动可能不同）
 * - label：系统给的名字（如 "Realtek Audio (Microphone)"），未授权时为空字符串
 * - groupId：同物理设备的 input/output 共用 groupId
 */
export interface AudioDeviceInfo {
  deviceId: string
  label: string
  groupId: string
}

/** 语音输入配置（引擎选择 + 后台发送行为等全局设置） */
export interface VoiceConfig {
  /**
   * 语音识别完成后的上屏方式（候选窗已移除，全部自动上屏以减少操作步骤）：
   * - 'auto'（默认）：识别完成后自动注入/粘贴上屏（前台注入 webview，后台 Ctrl+V 粘贴）
   * - 'manual'：同 'auto'，保留枚举仅为兼容旧配置（不再弹候选窗）
   * - 'clipboard'：仅写入剪贴板 + 系统通知，不模拟按键（用户手动粘贴）
   */
  confirmMode: 'auto' | 'manual' | 'clipboard'
  /** 前台注入后是否自动回车发送（后台粘贴场景不受此字段影响） */
  enterToSend: boolean
  /** 已下载的模型 ID 列表 */
  downloadedModels: string[]
  /** 当前选中的模型 ID */
  downloadModel: string
  /** 当前选中模型的下载状态 */
  downloadStatus: 'idle' | 'ready' | 'downloading' | 'failed'
  /** 识别引擎模式：builtin=内置Web Speech / ai=自定义AI接入 / local=本地识别软件 / download=轻量级下载 */
  sttMode: SttEngineMode
  /** AI 接入：服务商协议（存储 provider UUID） */
  aiProvider: string
  /**
   * 识别语言提示（仅影响 AI 接入类引擎）。
   * - 'zh'：中文（默认）
   * - 'en'：英文
   * - 'auto'：由模型自动判断
   * - 其他 ISO 639-1 简写
   */
  language: string
  /**
   * 麦克风设备 ID（getUserMedia 的 deviceId）。
   * 空字符串 = 使用系统默认麦克风。
   */
  inputDeviceId: string
  /**
   * 麦克风设备列表缓存（最近一次 enumerateDevices 结果）。
   * 用于设置页 UI 展示下拉选项。
   */
  inputDeviceList: AudioDeviceInfo[]
  /** 本地识别：可执行文件路径 */
  localExePath: string
  /** 本地识别：启动参数（模型路径等） */
  localArgs: string
  /**
   * whisper-cli 引擎二进制是否已下载（**持久化字段**）。
   * - 下载成功后置 true，存入 voice-config.json
   * - 启动时由 getVoiceConfig() 主动扫描磁盘进行修正（兜底：用户手动删文件/移动路径）
   * - 修复用户报告"每次打开设置页都看到下载按钮 / 点了又马上成功"的问题
   */
  cliDownloaded: boolean

  // ===== v0.5.2 regress-2：TTS（语音合成）独立配置 =====
  /** TTS 引擎模式：disable=关闭 / ai=自定义 AI 接入 */
  ttsMode?: 'disable' | 'ai'
  /** TTS 服务商标识（独立存储，存储 provider UUID） */
  ttsProvider?: string
}

/** 语音配置 CRUD + 触发接口 */
export interface VoiceConfigAPI {
  /** 读取语音配置 */
  getConfig(): Promise<VoiceConfig>
  /** 更新语音配置（合并 patch） */
  setConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig>
  /** 触发后台语音录音（显示独立预览窗，统一入口） */
  triggerStart(): Promise<void>
  /** 停止后台语音录音并注入发送（隐藏预览窗） */
  triggerStop(): Promise<void>
  /** 下载 whisper 模型文件（ggml-tiny/base/small.bin） */
  downloadModel(modelId: string): Promise<void>
  /** 下载 whisper-cli 识别引擎二进制 */
  downloadWhisperCli(): Promise<void>
  /**
   * 卸载 whisper-cli 引擎二进制：删除 userData/bin/ 下的所有可执行文件 + 修正 cfg.cliDownloaded=false。
   * 返回 { ok, removed, reason? }，removed 是已删除的文件名列表。
   * 不删除 _tmp_extract_* 临时目录（理论上不会残留，但保险起见也不动）。
   */
  uninstallWhisperCli(): Promise<{ ok: boolean; removed: string[]; reason?: string }>
  /**
   * 卸载指定 whisper 模型文件（按 modelId）：删除对应 ggml-*.bin + 从 cfg.downloadedModels 移除。
   * 返回 { ok, path?, reason? }。
   */
  uninstallModel(
    modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small',
  ): Promise<{ ok: boolean; path?: string; reason?: string }>
  /** 监听下载进度（主进程 → 渲染层）
   *  载荷 { type, percent, status, detail? }
   *  status 取值（精确字符串）：'下载中' | '解压中' | '完成' | '下载失败' | '下载已在进行中…'
   *  detail 仅在 status === '下载失败' 时附带具体错误描述 */
  onDownloadProgress(
    cb: (progress: {
      type: 'model' | 'cli'
      percent: number
      status: string
      detail?: string
    }) => void,
  ): () => void
  /** v0.5.2 regress-2：测试 TTS 配置连通性，返回 { ok, message, audioDataUrl? } */
  testTts(input: { providerId: string }): Promise<TestTtsResult>
}

/** 应用全局设置 */
export interface AppSettings {
  /** 是否隐藏国外模型/平台 */
  hideForeignModels: boolean
  /** 顶部标签栏是否默认收起（hover 才展开） */
  tabBarCollapsed: boolean
  /** 代理模式 */
  proxyMode: 'system' | 'direct' | 'custom'
  /** 自定义代理地址 */
  customProxy: string
  /** 自定义代理用户名（可选） */
  proxyUsername: string
  /** 自定义代理密码（可选） */
  proxyPassword: string
  /** 代理绕过列表（逗号分隔域名） */
  proxyBypass: string
  /** 用户手动隐藏的 AI 平台 id 列表（与一键隐藏国外模型叠加生效） */
  hiddenPlatforms: string[]
  /** Enter 键默认发送消息（Shift+Enter 换行），关闭后 Enter 换行 */
  enterToSend: boolean
  /** 默认桌面端 UA 对应的设备预设 id */
  defaultDesktopUaPreset: string
  /** 默认移动端 UA 对应的设备预设 id */
  defaultMobileUaPreset: string
  /** 关闭按钮行为：close=直接关闭退出 / minimize=最小化到托盘 */
  closeBehavior: 'close' | 'minimize'
  /** 开机自启动 */
  autoLaunch: boolean
  /** 静默启动（启动后隐藏到托盘，仅 autoLaunch=true 时有意义） */
  silentStart: boolean
  /** UI 比例：small=紧凑 / medium=中档（默认）/ large=大号 */
  uiScale: 'small' | 'medium' | 'large'
  /** 启动时默认打开：home=平台首页 / lastConversation=最近对话地址（无历史时回退首页） */
  startupOpen: 'home' | 'lastConversation'
  /** 引导是否已完成（首次启动为 false，完成引导后置 true，后续启动不再弹引导窗） */
  onboardingCompleted: boolean
  /** 顶栏可自定义显隐的按钮组（appSwitcher/menu/刷新/最小化/最大化/关闭始终显示） */
  topBarVisibleButtons: TopBarButtonGroup[]
  /** 点击已打开应用时的行为：switch=切换到该标签（默认）/ close=关闭该标签 */
  appClickBehavior: 'switch' | 'close'
  /** 弹窗白名单：URL 前缀数组，匹配的 URL 允许弹独立 BrowserWindow（登录/OAuth/验证页等） */
  popupWhitelist: string[]
  /** 缓存自动清理频率：never=不自动 / daily / weekly / monthly */
  cacheAutoClean: 'never' | 'daily' | 'weekly' | 'monthly'
  /** 上次缓存清理时间戳（ms），用于自动清理触发判定 */
  lastCacheCleanAt: number
  /** 下载目录绝对路径；空串=使用 app.getPath('downloads') */
  downloadDir: string
  /** 下载行为：ask=每次弹保存框 / auto=自动保存到 downloadDir */
  downloadBehavior: 'ask' | 'auto'
  /** 连续 Alt+Space 触发恢复主窗口默认位置的次数阈值（默认 6） */
  altSpaceResetThreshold: number
  /** 代理失败兜底：custom 代理加载失败时自动切换到兜底模式（默认关闭） */
  proxyFallbackEnabled: boolean
  /** 代理失败兜底模式：direct=直连 / system=系统代理 */
  proxyFallbackMode: 'direct' | 'system'
  /** 使用统计与操作日志：记录启动时间 + data-name 点击日志到 SQLite（默认开，完全本地存储） */
  usageTrackingEnabled: boolean
  /** 需求 7：Cookie 弹窗白名单（自动点击"接受全部"按钮） */
  cookieWhitelist: string[]
  /** 需求 7：Cookie 弹窗黑名单（直接隐藏所有 cookie 弹窗） */
  cookieBlacklist: string[]
  /** 需求 7：同域名 Cookie 弹窗冷却时间（ms），冷却期内不重复处理 */
  cookiePopupCooldownMs: number
  /** 需求 7：Cookie 弹窗自动处理总开关（默认 true） */
  cookieHandlerEnabled: boolean
  /** v0.5.2 R-3：进阶面板默认打开的 tab（Alt+Q 入口） */
  defaultAdvancedPanelTab: 'chat' | 'whiteboard' | 'notes'
  /** 白板应用层侧边栏是否可见（默认 false；Excalidraw 无内置多页面 UI，sidebar 是多白板管理入口） */
  whiteboardSidebarVisible: boolean
  /** 关闭所有广告屏蔽规则：开启后所有单独配置的屏蔽规则均不生效（默认 false） */
  disableAllBlockRules: boolean
  /** 灵感笔记侧边栏宽度（默认 160px，范围 120-400） */
  notesSidebarWidth: number
  /** 灵感笔记侧边栏是否收起 */
  notesSidebarCollapsed: boolean
  /** 自定义对话侧边栏宽度（默认 160px，范围 120-400） */
  chatSidebarWidth: number
  /** 自定义对话侧边栏是否收起 */
  chatSidebarCollapsed: boolean
}

/** 顶栏可显隐的按钮组标识（appSwitcher/menu/刷新始终显示，不在此列） */
export type TopBarButtonGroup =
  | 'uaToggle'
  | 'navBack'
  | 'navForward'
  | 'navHome'
  | 'themeToggle'
  | 'pinToggle'

/** 全部可自定义的顶栏按钮组（默认全选；appSwitcher/menu/刷新始终显示） */
export const ALL_TOP_BAR_BUTTON_GROUPS: TopBarButtonGroup[] = [
  'uaToggle',
  'navBack',
  'navForward',
  'navHome',
  'themeToggle',
  'pinToggle',
]

/** 应用全局设置 API */
export interface AppSettingsAPI {
  /** 读取应用全局设置 */
  get(): Promise<AppSettings>
  /** 更新应用全局设置（合并 patch） */
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  /** 测试代理连通性（返回 ok/latencyMs/message） */
  testProxy(): Promise<{ ok: boolean; latencyMs?: number; message: string }>
  /** 将当前代理配置即时应用到所有 session（无需重启） */
  applyProxy(): Promise<void>
  /**
   * 代理失败兜底：webview 加载失败时代理错误码触发，临时切换到兜底模式。
   * 返回 { switched, mode } —— switched=true 表示已切换，mode 为切换到的模式。
   */
  applyProxyFallback(): Promise<{ switched: boolean; mode: 'direct' | 'system' | null }>
  /** 清除所有用户数据（恢复出厂设置），完成后应用自动重启 */
  clearAllData(): Promise<boolean>
  /** 选择导出文件保存路径（弹出系统保存对话框） */
  selectExportPath(): Promise<string | null>
  /** 选择导入文件（弹出系统打开对话框） */
  selectImportFile(): Promise<string | null>
  /**
   * 导出数据到指定路径（细粒度控制）
   * @param targetPath 保存路径
   * @param options 导出选项（基础数据 / 登录凭据 / 应用数据 / 离线缓存 / 语音模型）
   */
  exportData(
    targetPath: string,
    options: {
      basicData: boolean;
      cookies: boolean;
      indexedDB: boolean;
      cache: boolean;
      voiceAssets: boolean;
    },
  ): Promise<{ success: boolean; filePath?: string; error?: string }>
  /** 从 zip 文件导入所有数据（导入后应用自动重启） */
  importData(zipPath: string): Promise<{ success: boolean; error?: string }>
  /**
   * 估算导出各类别体积（字节）
   * 返回 basicData/cookies/indexedDB/cache/voiceAssets 各项大小，
   * total 由渲染层按选中项累加
   */
  estimateExportSizes(): Promise<{
    basicData: number;
    cookies: number;
    indexedDB: number;
    cache: number;
    voiceAssets: number;
  }>
  /** 打开数据导出独立窗口（细粒度选择 + 体积提示，单例） */
  openExportWindow(): Promise<void>
  /** 清理缓存数据（仅缓存目录与 session cache，保留登录态） */
  cleanCache(): Promise<{ cleanedBytes: number }>
  /** 估算当前缓存体积（字节） */
  estimateCacheSize(): Promise<number>
  /** 选择下载目录（弹出系统目录选择对话框），返回选中路径或 null */
  selectDownloadDir(): Promise<string | null>
  /** 在系统文件管理器中打开下载目录 */
  openDownloadDir(): Promise<void>
  /** 读取拖拽文件并以 data URL 形式返回（用于跨 webview 边界传递文件内容） */
  dropFiles(filePaths: string[]): Promise<Array<{ filename: string; dataUrl: string; mime: string; size: number }>>
  /** 监听下载完成事件（主进程 → 渲染层：filename + path） */
  onDownloadDone(callback: (info: { filename: string; path: string }) => void): () => void
}

/** 引导 API（首次启动引导窗 + 重新查看入口） */
export interface OnboardingAPI {
  /** 打开引导窗（单例，已存在则聚焦） */
  show(): Promise<void>
  /** 查询引导是否已完成 */
  isCompleted(): Promise<boolean>
  /** 完成引导：合并保存 patch 到 app-settings，标记 onboardingCompleted=true，关闭引导窗，显示主窗口 */
  complete(patch?: Partial<AppSettings>): Promise<void>
}

/**
 * 灵感笔记 API（需求 11）
 * 笔记浮窗的 CRUD + 激活笔记管理 + 发送到 AI 输入框 + 存为提示词。
 */
/** 笔记列表筛选条件 */
export interface NoteListFilter {
  keyword?: string
  tag?: string
  pinnedOnly?: boolean
}

export interface NotesAPI {
  /** 列出笔记（支持搜索/标签/置顶筛选，按 pinned DESC, updatedAt DESC） */
  list(filter?: NoteListFilter): Promise<Note[]>
  /** 全文搜索（FTS5） */
  search(keyword: string): Promise<Note[]>
  /** 新增或更新笔记（upsert 语义：无 id 新增，有 id 更新） */
  save(input: NoteSaveInput): Promise<Note>
  /** 同步保存（beforeunload 兜底，sendSync） */
  saveSync(input: NoteSaveInput): { ok: boolean }
  /** 删除笔记 */
  delete(id: string): Promise<{ ok: boolean }>
  /** 获取当前激活的笔记（null=无激活） */
  getActive(): Promise<Note | null>
  /** 设置激活笔记（null=取消激活） */
  setActive(id: string | null): Promise<{ ok: boolean }>
  /** 设置置顶 */
  setPinned(id: string, pinned: boolean): Promise<{ ok: boolean }>
  /** 设置标签 */
  setTags(id: string, tags: string[]): Promise<{ ok: boolean }>
  /** 列出全部已用标签（去重） */
  listTags(): Promise<string[]>
  /** 发送笔记内容到当前 AI 输入框 */
  sendToAi(text: string, enterToSend?: boolean): Promise<{ ok: boolean; error?: string }>
  /** 把笔记内容保存为新的提示词模板 */
  saveAsPrompt(content: string, title?: string): Promise<{ ok: boolean; title?: string; error?: string }>
  /** 保存图片到磁盘，返回 notes-asset:// 路径（用于 markdown 中引用粘贴/拖拽的图片） */
  saveImage(dataUrl: string): Promise<{ ok: boolean; url?: string; error?: string }>
  /** 监听注入结果回传 */
  onInjectResult(callback: (result: { success: boolean; error?: string }) => void): () => void
}

/**
 * 白板 API（v3：Excalidraw + 多白板）
 */
export interface WhiteboardAPI {
  /** 列出全部白板 */
  list(): Promise<WhiteboardMeta[]>
  /** 新建白板 */
  create(title?: string): Promise<WhiteboardMeta>
  /** 重命名白板 */
  rename(id: string, title: string): Promise<{ ok: boolean }>
  /** 删除白板 */
  delete(id: string): Promise<{ ok: boolean }>
  /** 获取激活白板 id */
  getActive(): Promise<string | null>
  /** 设置激活白板 id */
  setActive(id: string | null): Promise<{ ok: boolean }>
  /** 加载白板 snapshot（Excalidraw scene JSON，无则 null） */
  getSnapshot(id: string): Promise<string | null>
  /** 异步保存 snapshot */
  saveSnapshot(id: string, snapshot: string): Promise<{ ok: boolean }>
  /** 同步保存 snapshot（beforeunload 兜底） */
  saveSnapshotSync(id: string, snapshot: string): { ok: boolean }
}

/** 通过 contextBridge 暴露到渲染进程的完整 API */
export interface ElectronAPI {
  profile: ProfileAPI
  window: WindowAPI
  windowControl: WindowControlAPI
  windowState: WindowStateAPI
  tab: TabAPI
  presets: PresetsAPI
  stt: SttAPI
  hotkey: HotkeyAPI
  aiPlatform: AIPlatformAPI
  prompt: PromptAPI
  /** 注入历史管理（需求 2：注入预览 + Jaccard 去重） */
  injection: InjectionHistoryAPI
  aiProvider: AIProviderAPI
  chat: ChatAPI
  fingerprint: FingerprintAPI
  /** 语音输入配置（enterToSend 等全局设置） */
  voice: VoiceConfigAPI
  /** 应用全局设置（区域代理、隐藏国外模型等） */
  appSettings: AppSettingsAPI
  /** 引导 API（首次启动引导窗 + 重新查看入口） */
  onboarding: OnboardingAPI
  /** 灵感笔记 API（需求 11：浮窗 CRUD + 发送到 AI 输入框 + 存为提示词） */
  notes: NotesAPI
  /** 白板 API（需求 12：无限画布 + 卡片 + 箭头 + 手绘线条） */
  whiteboard: WhiteboardAPI
  /** 平台能力查询（设置页显示权限状态） */
  platformCapabilities: PlatformCapabilitiesAPI
  /** 主进程 → 渲染层：拦截 webview 弹窗后新建标签页 */
  onNewTab: (callback: (url: string, windowId: string) => void) => () => void
  /**
   * 主→渲染：webview 弹窗 URL 转发（主进程拦截 window.open / target="_blank" 后，
   * 将 URL + guest webContents id 发回渲染层，由渲染层在匹配的当前 webview 内导航，
   * 实现页面内跳转而非弹出新窗口）。返回取消监听的函数。
   */
  onWebviewPopupUrl: (
    callback: (payload: { url: string; webContentsId: number }) => void,
  ) => () => void
  /**
   * 主→渲染：弹窗被连续拒绝达阈值（默认 3 次），提示用户是否将该 origin 加入白名单。
   * 返回取消监听的函数。
   */
  onPopupDenied: (
    callback: (payload: { url: string; origin: string; count: number }) => void,
  ) => () => void
  /** 渲染→主：将 origin 加入弹窗白名单（持久化到 AppSettings.popupWhitelist） */
  addToPopupWhitelist: (origin: string) => Promise<string[]>
  /** 渲染→主：将 origin 加入指定 Profile 的专属白名单（持久化到 Profile.popupWhitelist） */
  addToProfilePopupWhitelist: (profileId: string, origin: string) => Promise<string[]>
  /** 窗口重新显示/聚焦到前台（主→渲染：聚焦输入框） */
  onWindowShown: (callback: () => void) => () => void
  /** 窗口隐藏（主→渲染：自动收起展开的面板） */
  onWindowHidden: (callback: () => void) => () => void
  /** 主→最近聚焦窗口渲染：后台识别文本到达，注入 AI 输入框；enterToSend 控制是否自动发送 */
  onVoiceInjectAndSend: (cb: (payload: { text: string; enterToSend: boolean }) => void) => () => void
  /** 主→预览窗渲染：更新文本/状态 */
  onPreviewUpdate: (
    cb: (payload: { text: string; status: 'recording' | 'transcribing' | 'done' | 'sent' }) => void,
  ) => () => void
  /** 主→预览窗渲染：隐藏 */
  onPreviewHide: (cb: () => void) => () => void
  /** 主→预览窗渲染：开始录音（getUserMedia） */
  onVoiceRecordStart: (cb: () => void) => () => void
  /** 主→渲染：webview 内应用快捷键转发（主进程 before-input-event 拦截后通知渲染层执行） */
  onWebviewHotkey: (
    callback: (payload: {
      action: 'switchTab' | 'cycleTab' | 'toggleSpatialNav' | 'openShortcuts' | 'toggleTheme' | 'navBack' | 'navForward' | 'navRefresh' | 'newTab' | 'closeTab' | 'detachCurrent'
      data?: unknown
    }) => void,
  ) => () => void
  /** 主→预览窗渲染：停止录音并回传 PCM */
  onVoiceRecordStop: (cb: () => void) => () => void
  /** 预览窗渲染→主：回传 Float32 PCM 数据 */
  sendVoiceRecordData: (data: number[]) => void
  /**
   * 主→预览窗渲染：启动 builtin 模式 Web Speech API 识别。
   * 载荷 { language: string } 为 BCP-47 语种标签（如 'zh-CN'）。
   * 渲染层创建 webkitSpeechRecognition 实例并启动，结果通过 sendVoiceBuiltinResult 回传。
   */
  onVoiceBuiltinStart: (cb: (payload: { language: string }) => void) => () => void
  /** 预览窗渲染→主：回传 builtin 模式识别到的文本 */
  sendVoiceBuiltinResult: (text: string) => void
  /** 预览窗渲染→主：回传 builtin 模式识别错误信息 */
  sendVoiceBuiltinError: (error: string) => void
  /** 主→主窗口渲染：提示词库窗口请求注入模板到激活 webview（需求 1：传递完整模板由主窗口组合） */
  onPromptInjectRequest: (cb: (template: PromptTemplate) => void) => () => void
  /** 主→提示词库窗口渲染：注入结果回传 */
  onPromptInjectResult: (cb: (result: { success: boolean; platformName?: string }) => void) => () => void
  /** 主窗口渲染 → 主进程：回传注入结果（主进程转发到提示词库窗口，供其显示 toast） */
  sendPromptInjectResult: (result: { success: boolean; platformName?: string }) => void
  /** 页面组件屏蔽规则管理 */
  blockRules: BlockRulesAPI
  /**
   * 打开 AI 应用编辑窗口（多例，按 windowKey 单例）。
   * - 编辑模式：传 profileId 精确定位 Profile（支持同一平台多实例）
   * - 新建模式：mode='create'，表单空白，用户自由配置后创建
   */
  openAiAppEditor: (opts: {
    platformId?: string;
    profileId?: string;
    mode?: 'edit' | 'create';
  }) => Promise<void>
  /** 打开设置独立窗口（单例，左导航+右内容布局） */
  openSettingsWindow: () => Promise<void>
  /**
   * 打开 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）。
   * 可选 providerId：若提供则切换到对应自定义供应商的对话页。
   */
  openAdvancedPanelWindow: (providerId?: string) => Promise<void>
  /** 切换 进阶面板显隐（单例） */
  toggleAdvancedPanelWindow: () => Promise<void>
  /** 主→渲染：单例窗口复用时通知切换 tab/provider */
  onAdvancedPanelNavigate: (
    callback: (payload: { tab: 'chat' | 'whiteboard' | 'notes'; providerId?: string }) => void,
  ) => () => void
  /** 主→渲染：UI 比例变化广播（设置面板修改 uiScale 后通知各窗口重新计算最小尺寸） */
  onUiScaleChanged: (callback: (uiScale: 'small' | 'medium' | 'large') => void) => () => void
}

/** 页面组件屏蔽规则接口 */
export interface BlockRulesAPI {
  list(): Promise<BlockRule[]>
  save(rule: BlockRule): Promise<BlockRule>
  delete(id: string): Promise<void>
  update(id: string, patch: Partial<BlockRule>): Promise<BlockRule | null>
}

/** 平台能力查询接口（设置页显示权限状态） */
export interface PlatformCapabilitiesAPI {
  /** 获取当前平台的能力矩阵（安全存储、全局快捷键、辅助功能权限等） */
  get(): Promise<PlatformCapabilities>
}
