// electron/store/app-settings-store.ts — 应用全局设置读写与生效
//
// 应用设置持久化到 SQLite settings.db 的 app_settings 表（读写经 app-settings-repository）。
// 本文件只保留设置本体的合并更新、系统层同步（自启动）与跨窗口广播；
// IPC 注册在 electron/ipc/app-settings-ipc.ts，恢复出厂编排在 factory-reset.ts，
// Profile 快捷键重注册在 electron/ipc/profile-shortcut-ipc.ts。

import { app } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { isPortableMode } from './store-paths.js'
import {
  readSettingsRaw,
  writeSettingsRaw,
  validateAppSettingsPatch,
} from './app-settings-repository.js'
import type { AppSettings } from '../shared/api/settings.api.js'
export type { AppSettings } from '../shared/api/settings.api.js'
import { setRuntimeLogLevel } from '../diagnostics/application-log.js'

/** 更新应用设置（合并 patch） */
export function updateAppSettings(patch: Partial<AppSettings>): AppSettings {
  patch = validateAppSettingsPatch(patch)
  if (isPortableMode() && patch.autoLaunch)
    throw new Error('绿色便携版不注册开机自启动，请使用安装版。')
  const current = readSettingsRaw()
  const next: AppSettings = { ...current, ...patch }
  // 关闭 autoLaunch 时自动重置 silentStart=false（保持字段语义一致，避免 autoLaunch=false 但 silentStart=true 的非法态）
  if (patch.autoLaunch === false) {
    next.silentStart = false
  }
  writeSettingsRaw(next)
  // autoLaunch 或 silentStart 变化时立即同步系统注册项（避免必须重启应用才生效）
  if (patch.autoLaunch !== undefined || patch.silentStart !== undefined) {
    const ok = applyAutoLaunchSetting(next.autoLaunch, next.silentStart)
    if (!ok) {
      // 系统注册失败：回滚 store 字段并抛错，让渲染层 catch 后回滚本地 UI 状态
      writeSettingsRaw(current)
      throw new Error('应用开机自启动设置失败（系统层拒绝）')
    }
  }
  if (patch.logLevel !== undefined) setRuntimeLogLevel(next.logLevel)
  // UI 比例变化时广播到所有窗口，渲染层据此重新计算最小尺寸并调用 setMinimumSize
  if (patch.uiScale && patch.uiScale !== current.uiScale) {
    broadcastUiScaleChanged(next.uiScale)
  }
  // 广播设置变更到所有窗口（跨窗口同步：顶栏按钮、标签栏、主题、屏蔽规则等）
  broadcastAppSettingsChanged(next)
  return next
}

/**
 * 应用安装期选项到 AppSettings（首次启动播种 install-config.json 时调用）。
 * 将安装向导的 optionId 映射到 AppSettings 字段，复用 updateAppSettings 的
 * 合并 + autoLaunch 系统同步逻辑。optionId 与 installer/src/shared/install-manifest.ts
 * 的 INSTALL_OPTIONS 保持一致。
 */
export function applyInstallConfigOptions(options: Record<string, boolean | string>): void {
  const patch: Partial<AppSettings> = {}
  if (typeof options.autoUpdate === 'boolean') patch.autoUpdate = options.autoUpdate
  if (typeof options.autoLaunch === 'boolean') patch.autoLaunch = options.autoLaunch
  if (typeof options.usageTracking === 'boolean') patch.usageTrackingEnabled = options.usageTracking
  if (typeof options.logLevel === 'string') {
    const v = options.logLevel
    if (v === 'error' || v === 'warn' || v === 'info' || v === 'debug') {
      patch.logLevel = v
    }
  }
  if (Object.keys(patch).length === 0) return
  updateAppSettings(patch)
}

/**
 * 向所有 BrowserWindow 广播 UI 比例变化。
 * 各窗口渲染层收到后，根据自身窗口类型重新计算最小宽度并调用 setMinimumSize。
 */
function broadcastUiScaleChanged(uiScale: 'small' | 'medium' | 'large'): void {
  broadcastToAllWindows(IPC_CHANNELS.UI_SCALE_CHANGED, uiScale, 'app-settings')
}

/** 向所有 BrowserWindow 广播应用设置变更（跨窗口同步） */
function broadcastAppSettingsChanged(settings: AppSettings): void {
  broadcastToAllWindows(IPC_CHANNELS.APP_SETTINGS_CHANGED, settings, 'app-settings')
}

/**
 * 应用开机自启动设置到系统。
 * 调用 Electron app.setLoginItemSettings，根据 silentStart 决定是否注入 --hidden 参数。
 * - silentStart=true：启动时带 --hidden，隐藏到托盘
 * - silentStart=false：启动时正常显示主窗口
 * @returns 是否设置成功（失败时返回 false 但不抛异常）
 */
export function applyAutoLaunchSetting(enabled: boolean, silentStart: boolean): boolean {
  if (isPortableMode()) return !enabled
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: silentStart ? ['--hidden'] : [],
    })
    console.log(
      `[app-settings] 自启动设置已${enabled ? '开启' : '关闭'}${silentStart ? '（静默启动）' : ''}`,
    )
    return true
  } catch (e) {
    console.error('[app-settings] 设置自启动失败:', (e as Error).message)
    return false
  }
}
