// electron/store/default-config.ts — 统一默认配置路由器
//
// 所有"默认值是什么？"的问题都经过此文件路由：
//   用户设置了偏好 → 使用用户偏好
//   用户没设置     → 自动使用第一个代码项
//
// 各 Store 通过 import 调用路由函数，不在本地做默认值逻辑。
// 便捷路由函数见 preset-store.ts（getDefaultDesktopPreset / getDefaultMobilePreset）
// 与 prompt-store.ts（getDefaultPrompt）。
//
// 添加新配置的三步：
//   1. 在下方定义配置数组（第一个元素即默认值）
//   2. 导出类型数组供各 Store import
//   3. 如需便捷路由函数，在对应 Store 中添加

import type { DevicePreset, PromptTemplate, Profile, FingerprintConfig } from '../shared/types.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
import { IPHONE_VIEWPORT } from '../presets/devices.js'
import type { VoiceConfig } from './voice-store.js'

// Block Rules 预置数据量大，独立成文件（block-rules-preset.ts），此处路由导出
export { BLOCK_RULES } from './block-rules-preset.js'

// =============================================================================
// 路由器核心
// =============================================================================

/**
 * 通用配置路由器：从列表中返回用户偏好的项，或第一个代码项。
 * 这是所有"默认值解析"的唯一入口。
 */
export function getDefault<T extends { id: string }>(
  items: T[],
  userPreferredId?: string | null,
): T {
  if (userPreferredId) {
    const found = items.find((item) => item.id === userPreferredId)
    if (found) return found
  }
  return items[0]
}

/**
 * 用户偏好键名常量（存储在 MetaTable / AppSettings 中的 key）
 * 各 Store 使用这些常量读写用户偏好，避免硬编码字符串。
 */
export const PREF_KEYS = {
  /** 用户偏好的桌面端 UA 预设 ID */
  desktopUaPreset: 'defaultDesktopUaPreset',
  /** 用户偏好的移动端 UA 预设 ID */
  mobileUaPreset: 'defaultMobileUaPreset',
  /** 用户偏好的默认高级面板 Tab */
  advancedPanelTab: 'defaultAdvancedPanelTab',
  /** 用户偏好的搜索引擎 */
  searchEngine: 'defaultSearchEngine',
} as const

// =============================================================================
// AppSettings 默认值
// =============================================================================

export { getDefaultAppSettings } from './app-settings-defaults.js'
export type { DefaultAppSettings } from './app-settings-defaults.js'

// =============================================================================
// 路由便捷函数：各 Store 调用这些函数获取默认值
// =============================================================================

/**
 * 路由：获取默认桌面端 UA 预设。
 * 用户在 AppSettings.defaultDesktopUaPreset 中保存偏好 ID，未设置则返回 PRESETS[0]。
 */
export function resolveDefaultDesktopPreset(desktopUaPresetId: string): DevicePreset {
  return getDefault(PRESETS, desktopUaPresetId)
}

/**
 * 路由：获取默认移动端 UA 预设。
 * 用户在 AppSettings.defaultMobileUaPreset 中保存偏好 ID，未设置则返回 PRESETS[2]（iPhone）。
 * 注意：移动端特殊处理——第一个 PRESETS 项是桌面端，所以这里用 PRESETS[2] 作为无偏好时的 fallback。
 */
export function resolveDefaultMobilePreset(mobileUaPresetId: string): DevicePreset {
  // 移动端预设从 PRESETS 中按 platform='mobile' 过滤后取第一个，或直接用用户偏好
  if (mobileUaPresetId) {
    const found = PRESETS.find((p) => p.id === mobileUaPresetId)
    if (found) return found
  }
  return PRESETS.find((p) => p.platform === 'mobile') ?? PRESETS[0]
}

/**
 * 路由：获取默认提示词模板。
 * 从 PROMPTS 列表中返回用户偏好的模板，或第一个模板。
 * 注意：PromptTemplate 在存储时有 id 字段，但 PROMPTS 定义时没有。
 * 此函数用于新建模板时的默认值参考。
 */
export function getDefaultPromptTemplate(): Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  return PROMPTS[0]
}


// =============================================================================
// Device Presets（第一个元素即默认预设）
// =============================================================================

/** 预置预设数据版本号（用于后续迁移） */
export const PRESETS_VERSION = 1

/** iPhone 15 Pro / Safari 移动端 UA */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** Windows / Chrome 125 桌面端 UA */
const WIN_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/** 预置设备预设（id 使用固定值便于幂等填充） */
export const PRESETS: DevicePreset[] = [
  {
    id: 'win-chrome-125',
    name: 'Windows / Chrome 125',
    userAgent: WIN_CHROME_UA,
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigatorPlatform: 'Win32',
    vendor: 'Google Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Windows',
    chPlatformVersion: '10.0.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'mac-safari-17',
    name: 'macOS / Safari 17',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'desktop',
    viewport: { width: 1680, height: 1050 },
    devicePixelRatio: 2,
    navigatorPlatform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'iphone-15-pro-safari',
    name: 'iPhone 15 Pro / Safari',
    userAgent: IPHONE_UA,
    platform: 'mobile',
    viewport: IPHONE_VIEWPORT,
    devicePixelRatio: 3,
    navigatorPlatform: 'iPhone',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 6,
    deviceMemory: 4,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'ipad-pro-safari',
    name: 'iPad Pro / Safari',
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'mobile',
    viewport: { width: 1024, height: 1366 },
    devicePixelRatio: 2,
    navigatorPlatform: 'iPad',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
  {
    id: 'pixel-8-chrome',
    name: 'Pixel 8 Pro / Chrome',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    platform: 'mobile',
    viewport: { width: 412, height: 892 },
    devicePixelRatio: 3.5,
    navigatorPlatform: 'Linux armv8l',
    vendor: 'Google Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 12,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Android',
    chPlatformVersion: '14.0.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    builtin: true,
  },
]

// =============================================================================
// Prompt Templates（第一个元素即默认模板）
// =============================================================================

/** 首次启动填充的通用预置模板（不含 id/createdAt/updatedAt，由 save 时补全） */
export const PROMPTS: Array<Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>> = [
  { title: '总结全文', content: '请用简洁的语言总结以下内容的要点，分条列出：\n\n{{body}}', category: '通用' },
  { title: '翻译为英文', content: '请将以下内容翻译为自然流畅的英文：\n\n{{body}}', category: '通用' },
  { title: '扩写细节', content: '请在保持原意的基础上，扩写以下内容，补充更多细节与示例：\n\n{{body}}', category: '通用' },
  { title: '润色优化', content: '请润色以下文字，使其更专业、流畅，并保留原意：\n\n{{body}}', category: '通用' },
  { title: '解释代码', content: '请逐行解释以下代码的作用与实现思路：\n\n{{body}}', category: '开发' },
]

// =============================================================================
// AI Platforms 导出（单一数据源）
// =============================================================================

/** 内置 AI 平台列表（从 presets/ai-platforms.ts 重导出） */
export { AI_PLATFORMS }

// =============================================================================
// Profile 默认值生成
// =============================================================================

/**
 * Profile 创建参数（用于 ensureDefaultProfiles）
 */
export interface DefaultProfileParams {
  name: string
  isBuiltIn: boolean
  devicePreset: string
  userAgent: string
  platform: 'mobile' | 'desktop'
  viewport: { width: number; height: number }
  devicePixelRatio: number
  language: string
  timezone: string
  isAIPlatform: boolean
  aiPlatformUrl: string
  aiPlatformId: string
  aiPlatformRegion: 'cn' | 'global'
  aiDesktopPreset: string
  aiMobilePreset: string
  aiThemeColor: string
  width: number
  height: number
  order: number
  fingerprint: FingerprintConfig
}

/**
 * 生成默认 AI 平台 Profile 列表。
 * 基于 AI_PLATFORMS 和 iPhone 15 Pro 视口尺寸生成 9 个 Profile 参数。
 *
 * @returns Profile 创建参数数组（可直接传给 profileStore.create）
 */
export function getDefaultProfileParams(): DefaultProfileParams[] {
  return AI_PLATFORMS.map((platform, index) => ({
    name: platform.name,
    isBuiltIn: platform.id === 'deepseek',
    devicePreset: platform.defaultMobilePreset,
    userAgent: platform.defaultUA,
    platform: 'mobile' as const,
    viewport: {
      width: IPHONE_VIEWPORT.width,
      height: IPHONE_VIEWPORT.height,
    },
    devicePixelRatio: 3, // iPhone 15 Pro 固定 3x
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    isAIPlatform: true,
    aiPlatformUrl: platform.url,
    aiPlatformId: platform.id,
    aiPlatformRegion: platform.region,
    aiDesktopPreset: platform.defaultDesktopPreset,
    aiMobilePreset: platform.defaultMobilePreset,
    aiThemeColor: platform.themeColor,
    width: IPHONE_VIEWPORT.width,
    height: IPHONE_VIEWPORT.height,
    order: index,
    fingerprint: {
      seed: Math.floor(Math.random() * 0xffffffff),
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      fonts: 'noise',
      webrtc: 'real',
    },
  }))
}

// =============================================================================
// VoiceConfig（语音配置默认值）
// =============================================================================

/** 语音配置默认值 */
export const VOICE_CONFIG: VoiceConfig = {
  confirmMode: 'auto',
  inputMethod: 'layered',
  enterToSend: false,
  sttMode: 'ai',
  aiProvider: '',
  language: 'zh',
  localExePath: '',
  localArgs: '',
  inputDeviceId: '',
  inputDeviceList: [],
  ttsMode: 'disable',
  ttsProvider: '',
}

// =============================================================================
// Profile 默认值（创建新 Profile 时使用）
// =============================================================================

/** Windows Chrome 125 默认 UA（与 presets/devices.ts 中 win-chrome-125 预设一致） */
const WINDOWS_CHROME_125_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

/**
 * 创建默认 Profile 的参数模板
 * 指纹种子每次随机，保证 Profile 间指纹差异。
 */
export function createDefaultProfileParams(): Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '未命名 Profile',
    devicePreset: 'win-chrome-125',
    userAgent: WINDOWS_CHROME_125_UA,
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    proxy: '',
    fingerprint: {
      seed: Math.floor(Math.random() * 0xffffffff),
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      fonts: 'noise',
      webrtc: 'real',
    },
    // 默认窗口尺寸：类似旧版 QQ 的窄长条形
    width: 320,
    height: 720,
    alwaysOnTop: false,
    order: 0,
    // 浏览器独立窗口主页 URL（留空时回退到 aiPlatformUrl）
    browserHomePage: '',
  }
}
