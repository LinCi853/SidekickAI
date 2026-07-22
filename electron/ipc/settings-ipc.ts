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
import { AI_PLATFORMS } from '../presets/ai-platforms.js'
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

/** 注册预设与 AI 平台查询相关 IPC handler */
export function registerSettingsIpc(): void {
  // ===== 预设 / AI 平台 IPC =====
  ipcMain.handle(IPC_CHANNELS.PRESETS_LIST, async () => presetStore.list())
  ipcMain.handle(IPC_CHANNELS.PRESETS_GET, async (_e, id: string) =>
    presetStore.get(id),
  )
  // AI 平台列表：合并 Profile 上的用户自定义覆盖（region / desktopPreset / mobilePreset / themeColor）
  ipcMain.handle(IPC_CHANNELS.AI_PLATFORM_LIST, async () => {
    const profiles = profileStore.list()
    return AI_PLATFORMS.map((p) => {
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
  })
}
