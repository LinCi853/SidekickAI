// profile.types.ts — Profile / 设备预设 / 内置 AI 平台 数据模型
// 由 shared/types.ts 拆分而来；类型定义内容保持原样，仅做物理拆分。

import type { FingerprintConfig } from './fingerprint.types.js'

/** 平台类型：桌面端 / 移动端 */
export type PlatformType = 'desktop' | 'mobile'

// ============================================================================
// 设备预设（devicePreset 引用）
// ============================================================================

/** 设备预设：预置的 UA + viewport + DPR + Client Hints 一致性配置 */
export interface DevicePreset {
  /** 预设唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 完整 User-Agent 字符串 */
  userAgent: string
  /** 平台类型 */
  platform: PlatformType
  /** 视口尺寸 */
  viewport: { width: number; height: number }
  /** 设备像素比 */
  devicePixelRatio: number
  /** navigator.platform 值 */
  navigatorPlatform: string
  /** navigator.vendor 值 */
  vendor: string
  /** 最大触点数 */
  maxTouchPoints: number
  /** CPU 核心数（hardwareConcurrency） */
  hardwareConcurrency: number
  /** 设备内存（deviceMemory，GB） */
  deviceMemory: number
  /** Client Hints 品牌列表 */
  brands: { brand: string; version: string }[]
  /** Client Hints 平台 */
  chPlatform: string
  /** Client Hints 平台版本 */
  chPlatformVersion: string
  /** Client Hints 是否移动端 */
  chMobile: boolean
  /** 默认语言 */
  language: string
  /** 默认时区 */
  timezone: string
  /** 是否内置预设（内置预设不可删除） */
  builtin?: boolean
}

// ============================================================================
// Profile 数据模型（核心）
// ============================================================================

/** Profile：一个完整的「虚拟浏览器身份」 */
export interface Profile {
  // 基础
  /** 唯一标识（UUID） */
  id: string
  /** 显示名称 */
  name: string
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number

  // 浏览器层
  /** 引用的设备预设 id（或 'custom' 表示自定义 UA） */
  devicePreset: string
  /** User-Agent（可覆盖预设值） */
  userAgent: string
  /** 平台类型 */
  platform: PlatformType
  /** 视口尺寸 */
  viewport: { width: number; height: number }
  /** 设备像素比 */
  devicePixelRatio: number
  /** 语言 */
  language: string
  /** 时区 */
  timezone: string
  /** 代理配置（空字符串=直连） */
  proxy: string

  // 指纹层
  /** 指纹配置 */
  fingerprint: FingerprintConfig

  // 窗口层
  /** 窗口宽度 */
  width: number
  /** 窗口高度 */
  height: number
  /** 窗口 X 坐标 */
  x?: number
  /** 窗口 Y 坐标 */
  y?: number
  /** 是否置顶 */
  alwaysOnTop: boolean
  /** 排序序号（用户可拖拽调整 AI 应用顺序，值越小越靠前） */
  order: number

  // AI 聚合扩展（AI 窗口特有）
  /** 是否为 AI 平台 Profile（聚合 9 个内置 AI 平台） */
  isAIPlatform?: boolean
  /** v0.0.9: 保底内置应用（不可删除、不可重命名，如默认 DeepSeek） */
  isBuiltIn?: boolean
  /** AI 平台 URL（isAIPlatform=true 时有效） */
  aiPlatformUrl?: string
  /** 内置 AI 平台 id（isAIPlatform=true 时有效，用于稳定关联平台与 Profile） */
  aiPlatformId?: string
  /** AI 平台地区标识（用户可覆盖：cn=国内 / global=国外，与一键隐藏国外模型联动） */
  aiPlatformRegion?: 'cn' | 'global'
  /** AI 平台桌面端 UA 预设 id（用户覆盖，窄屏自动切换） */
  aiDesktopPreset?: string
  /** AI 平台移动端 UA 预设 id（用户覆盖，宽屏自动切换） */
  aiMobilePreset?: string
  /**
   * UA 锁定模式：控制 webview 的 UA 切换策略。
   * - 'auto'（默认/未定义）：根据窗口宽度自动在 mobile/desktop 预设间切换
   * - 'mobile'：强制锁定移动端 UA 预设
   * - 'desktop'：强制锁定桌面端 UA 预设
   * 顶栏左侧三态按钮可循环切换；持久化到 Profile 级以便不同平台使用不同策略。
   */
  uaLockMode?: 'auto' | 'mobile' | 'desktop'
  /** AI 平台主题色（用户覆盖，#RRGGBB） */
  aiThemeColor?: string
  /** AI 平台输入框 CSS 选择器（用户覆盖，留空用平台预设 inputSelector） */
  aiInputSelector?: string
  /** AI 平台发送按钮 CSS 选择器（用户覆盖，留空用平台预设 sendSelector） */
  aiSendSelector?: string
  /**
   * 该 AI 应用专属的弹窗白名单（origin 前缀数组，如 'https://auth.openai.com/'）。
   *
   * 与全局 AppSettings.popupWhitelist 的关系：
   * - 主进程 setWindowOpenHandler 在判断弹窗时合并三层白名单：
   *   ① 全局默认登录域（AppSettings.popupWhitelist，作为兜底，所有应用共享）
   *   ② 平台 allowedOrigins（AIPlatform.allowedOrigins，平台关联域）
   *   ③ 本字段（Profile.popupWhitelist，应用专属自定义）
   * - 用户在 AiAppEditor 中编辑；onPopupDenied 自动加白时写入本字段而非全局
   * - 留空时仅依赖 ①② 两层兜底
   */
  popupWhitelist?: string[]
}

// ============================================================================
// 内置 AI 平台（聚合功能）
// ============================================================================

/** 内置 AI 平台定义 */
export interface AIPlatform {
  /** 平台 id */
  id: string
  /** 显示名称 */
  name: string
  /** 网页版 URL */
  url: string
  /** 地区：cn=国内 / global=国外 */
  region: 'cn' | 'global'
  /** 默认桌面端 UA 对应的设备预设 id（默认值，用户可在设置中覆盖） */
  defaultDesktopPreset: string
  /** 默认移动端 UA 对应的设备预设 id（默认值，用户可在设置中覆盖） */
  defaultMobilePreset: string
  /** 默认 UA（兼容旧字段，值等于 defaultMobilePreset 对应 UA） */
  defaultUA: string
  /** 默认分辨率 */
  defaultResolution: { width: number; height: number }
  /** 默认语言 */
  defaultLanguage: string
  /** 输入框 CSS 选择器（用于提示词注入），未设置则用通用兜底 */
  inputSelector?: string
  /** 发送按钮 CSS 选择器（用于 triggerSend），未设置则用 Enter 回车键兜底 */
  sendSelector?: string
  /** 文件上传 input 的 CSS 选择器（用于拖拽导入找 input[type=file]），未设置则用通用 input[type=file] */
  fileInputSelector?: string
  /** 拖放区 CSS 选择器（用于拖拽导入合成 drop 事件的派发目标），未设置则用启发式候选 */
  dropZoneSelector?: string
  /** 主题色（主打色，#RRGGBB，用于标签图标、呼吸灯等） */
  themeColor: string
  /** 渐变色（从 themeColor 衍生的第二个色，用于渐变背景） */
  gradientColor: string
  /**
   * 允许跳转的相关域名清单（origin 前缀，含 scheme + host）。
   * 主进程 setWindowOpenHandler 在跨域 popup 判断时优先匹配此清单：
   * 若目标 origin 命中，则视为「同域」处理（页面内跳转，不开新窗口），
   * 避免各平台多域名场景（如 mimo 的 mimo.xiaomi.com / aistudio.xiaomimimo.com、
   * ChatGPT 的 chat.openai.com / chatgpt.com）被误判为「跳转到应用外页面」。
   * 未配置时仅按当前 URL origin 做同域判断。
   */
  allowedOrigins?: string[]
  /**
   * 会话 URL 路径前缀清单（pathname 起始匹配，如 ['/c/', '/chat/', '/conversation/']）。
   * 渲染层 click 拦截器对这些路径放行原生处理，避免与站点 SPA 路由冲突。
   * 未配置时使用通用兜底白名单。
   */
  conversationUrlPatterns?: string[]
}
