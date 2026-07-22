// window.types.ts — 窗口形态 / 标签页 / 窗口状态 / 对话窗口配置
// 由 shared/types.ts 拆分而来；类型定义内容保持原样，仅做物理拆分。

/** 窗口形态：小窗置顶 / 标准 / 独立 */
export type WindowMode = 'mini' | 'standard' | 'independent'

// ============================================================================
// 标签页与窗口状态（多标签 + 脱离窗口架构）
// ============================================================================

/** 标签页状态：一个打开的 AI 平台实例 */
export interface TabState {
  /** 标签唯一 id（UUID） */
  id: string
  /** 关联的 Profile id（决定 UA / 指纹 / session partition） */
  profileId: string
  /** 标签标题（可编辑，默认取平台名） */
  title: string
  /** 在标签栏中的排序（从 0 开始） */
  order: number
  /** 自定义 URL（可选）；未设置时使用 profile.aiPlatformUrl */
  url?: string
  /** 该标签的"首页"地址（可选）；点击"回到首页"时跳转到这里；未设置时使用 profile.aiPlatformUrl */
  homeUrl?: string
  /** 是否因窄屏自动切换为移动端 UA（窗口变宽后可切回桌面端） */
  autoMobile?: boolean
  /** 自动切换前的原始 devicePreset id（用于恢复） */
  originalDevicePreset?: string
}

/** 窗口持久化状态：主窗口 + 每个脱离的独立窗口各一份 */
export interface WindowStateData {
  /** 窗口 id：'main' 或 UUID（脱离窗口） */
  windowId: string
  /** 窗口位置与尺寸 */
  bounds: { x?: number; y?: number; width: number; height: number }
  /** 是否最大化 */
  isMaximized: boolean
  /** 最大化前的窗口尺寸（用于还原） */
  normalBounds?: { x?: number; y?: number; width: number; height: number }
  /** 是否全屏 */
  isFullscreen?: boolean
  /** 全屏前的正常窗口尺寸（用于退出全屏后还原） */
  fullscreenNormalBounds?: { x?: number; y?: number; width: number; height: number }
  /** 是否置顶 */
  alwaysOnTop: boolean
  /** 当前激活的标签 id（null=无标签） */
  activeTabId: string | null
  /** 标签列表（顺序即展示顺序） */
  tabs: TabState[]
  /** 底栏是否展开 */
  bottomBarExpanded: boolean
  /** 底栏展开时的高度（px），未设置使用默认值 */
  bottomBarHeight?: number
  /** 窗口模式：'webview'（默认，加载 AI 平台网页）| 'chat'（自定义 AI 对话，渲染 ChatView） */
  mode?: 'webview' | 'chat'
  /** chat 模式专属配置（mode='chat' 时生效） */
  chatConfig?: ChatWindowConfig
  /** 最近一次打开使用的时间戳（AppSwitcher 排序依据；null=从未使用，排在最后） */
  lastUsedAt?: number | null
}

/** 自定义对话窗口配置（mode='chat' 时绑定） */
export interface ChatWindowConfig {
  /** 绑定的自定义 AI 供应商 id */
  providerId: string
  /** 窗口标题（显示在顶栏，可选） */
  title?: string
  /** 样式配置 */
  style?: ChatWindowStyle
  /** 用户代理（UA）。留空则用默认；可选预设：'safari-ios' | 'chrome-desktop' | 'custom' */
  userAgent?: string
  /** UA 预设类型，便于 UI 展示；'custom' 时使用 userAgent 字段 */
  uaPreset?: 'safari-ios' | 'chrome-desktop' | 'custom'
  /** 窗口形式：narrow（窄长，默认 480x760）/ standard（标准 720x640）/ wide（宽屏 1000x680） */
  windowForm?: 'narrow' | 'standard' | 'wide'
  /** 默认提示词：每次新对话自动填入的第一条 user 消息（可选） */
  defaultPrompt?: string
  /** 系统提示词：发送给 API 的 system message（可选） */
  systemPrompt?: string
  /** 窗口初始尺寸（覆盖 windowForm 的默认值，可选） */
  bounds?: { width: number; height: number }
  /** 需求 10：记录文本模板前缀（assistant 消息保存前附加，支持 {{time}} {{tag}} 占位符） */
  recordTextPrefix?: string
  /** 需求 10：记录文本模板后缀 */
  recordTextSuffix?: string
  /** 需求 10：该窗口最近一次使用的会话 id（替代按 providerId 键入的 localStorage） */
  lastConversationId?: string
}

/** 自定义对话窗口样式配置 */
export interface ChatWindowStyle {
  /** 强调色（hex，如 '#c25a4a'），覆盖默认暖砖红 */
  accentColor?: string
  /** 信息密度：'compact'（紧凑）| 'comfortable'（舒适，默认） */
  density?: 'compact' | 'comfortable'
  /** 是否显示头像 */
  showAvatar?: boolean
  /** 是否显示时间戳 */
  showTimestamp?: boolean
  /** 代码块主题 */
  codeTheme?: 'github-dark' | 'github-light'
}
