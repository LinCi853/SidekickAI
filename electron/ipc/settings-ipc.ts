// electron/ipc/settings-ipc.ts — 预设与 AI 平台查询 IPC 注册
//
// 包含：
//   - PRESETS_LIST：列出所有设备预设
//   - PRESETS_GET：按 id 获取单个设备预设
//   - AI_PLATFORM_LIST：列出所有预置 AI 平台（合并 Profile 的 region 覆盖）
//
// 在 app.whenReady 后由 main.ts 调用 registerSettingsIpc() 完成注册。

import { ipcMain } from 'electron'
import { IPC_CHANNELS, type AIPlatform } from '../shared/types.js'
import type { Profile } from '../shared/profile.types.js'
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
import { IPHONE_UA, IPHONE_VIEWPORT } from '../presets/devices.js'
import { profileStore } from '../store/profile-store.js'
import { presetStore } from '../store/preset-store.js'

/** 从主题色衍生渐变色（变暗 20%） */
function deriveGradientColor(hex: string): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return hex
  const r = Math.max(0, Math.min(255, Math.round(parseInt(m[1], 16) * 0.8)))
  const g = Math.max(0, Math.min(255, Math.round(parseInt(m[2], 16) * 0.8)))
  const b = Math.max(0, Math.min(255, Math.round(parseInt(m[3], 16) * 0.8)))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * 为「未绑定预设平台」的自定义 AI 应用合成为一个 AIPlatform 项，
 * 让所有切换 UI（AppSwitcher / BottomBar / AiAppSection）能识别并展示它。
 *
 * - id 用 `custom:<profileId>` 前缀避免与预设 id 冲突
 * - region 默认 'cn'：用户自定义应用应默认可见（hideForeignModels 默认开启时不被屏蔽）
 *   用户可在 AiAppEditor 中显式设置为 'global' 以纳入「国外模型」过滤
 * - 选择器/UA 等字段沿用 Profile 上的用户覆盖；未设置则用通用兜底
 */
function synthesizeCustomPlatform(profile: Profile): AIPlatform {
  const themeColor = profile.aiThemeColor ?? '#4a5568'
  return {
    id: `custom:${profile.id}`,
    name: profile.name ?? '未命名 AI 应用',
    url: profile.aiPlatformUrl ?? '',
    region: profile.aiPlatformRegion ?? 'cn',
    defaultDesktopPreset: profile.aiDesktopPreset ?? 'win-chrome-125',
    defaultMobilePreset: profile.aiMobilePreset ?? 'iphone-15-pro-safari',
    defaultUA: IPHONE_UA,
    defaultResolution: IPHONE_VIEWPORT,
    defaultLanguage: 'zh-CN',
    inputSelector: profile.aiInputSelector,
    sendSelector: profile.aiSendSelector,
    themeColor,
    gradientColor: deriveGradientColor(themeColor),
  }
}

/** 注册预设与 AI 平台查询相关 IPC handler */
export function registerSettingsIpc(): void {
  // ===== 预设 / AI 平台 IPC =====
  ipcMain.handle(IPC_CHANNELS.PRESETS_LIST, async () => presetStore.list())
  ipcMain.handle(IPC_CHANNELS.PRESETS_GET, async (_e, id: string) =>
    presetStore.get(id),
  )
  // AI 平台列表：合并 Profile 上的用户自定义覆盖（region / desktopPreset / mobilePreset / themeColor）
  // 同时为「未绑定预设」的自定义 AI 应用合成 AIPlatform 项追加到列表末尾，
  // 否则 AppSwitcher / BottomBar / AiAppSection 反向匹配平台时找不到对应项会过滤掉自定义应用。
  ipcMain.handle(IPC_CHANNELS.AI_PLATFORM_LIST, async () => {
    const profiles = profileStore.list()
    // 1) 预设平台：合并匹配 profile 的覆盖
    const presetResults = AI_PLATFORMS.map((p) => {
      const profile = profiles.find(
        (pr) => pr.isAIPlatform && (pr.aiPlatformId === p.id || pr.aiPlatformUrl === p.url),
      )
      if (!profile) return p
      const result: AIPlatform = { ...p }
      if (profile.aiPlatformRegion) {
        result.region = profile.aiPlatformRegion
      }
      if (profile.aiDesktopPreset) {
        result.defaultDesktopPreset = profile.aiDesktopPreset
      }
      if (profile.aiMobilePreset) {
        result.defaultMobilePreset = profile.aiMobilePreset
      }
      if (profile.aiThemeColor) {
        result.themeColor = profile.aiThemeColor
        // 渐变色从主题色衍生（变暗 20%）
        result.gradientColor = deriveGradientColor(profile.aiThemeColor)
      }
      return result
    })
    // 2) 已被预设匹配的 profile id（用于排除已绑定的，避免重复）
    const matchedProfileIds = new Set(
      profiles
        .filter(
          (pr) =>
            pr.isAIPlatform &&
            AI_PLATFORMS.some(
              (p) => p.id === pr.aiPlatformId || p.url === pr.aiPlatformUrl,
            ),
        )
        .map((pr) => pr.id),
    )
    // 3) 自定义 AI 应用（未绑定预设）：合成为 AIPlatform 项追加到列表末尾
    const customResults: AIPlatform[] = profiles
      .filter((pr) => pr.isAIPlatform && !matchedProfileIds.has(pr.id))
      .map((pr) => synthesizeCustomPlatform(pr))
    return [...presetResults, ...customResults]
  })
}
