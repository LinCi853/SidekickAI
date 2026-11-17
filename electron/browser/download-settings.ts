// electron/browser/download-settings.ts — 下载与保存位置的生效设置
//
// 主应用设置里的全局默认是所有 AI 应用的默认值；某个 AI 应用可以在自己的
// 浏览器设置里改为独立设置（Profile.downloadSettings.mode='custom'）。
// 生效优先级：AI 应用独立设置 > 主应用全局默认。
//
// 本模块不直接读取 Profile：调用方把该 AI 应用的独立设置传进来，
// 写回时也由调用方提供写回入口，避免与 profile-store 形成依赖环。

import { getAppSettings } from '../store/app-settings-repository.js'
import { updateAppSettings } from '../store/app-settings-store.js'
import { resolveSaveDirectory } from '../store/default-save-location.js'
import type {
  DownloadBehavior,
  ProfileDownloadSettings,
} from '../shared/download-settings.types.js'

export interface EffectiveDownloadSettings {
  /** 生效的保存目录（绝对路径） */
  downloadDir: string
  /** 生效的下载行为 */
  downloadBehavior: DownloadBehavior
  /** 生效来源：profile=该 AI 应用独立设置，global=跟随主应用默认 */
  source: 'profile' | 'global'
}

/**
 * 解析某个 AI 应用当前生效的下载设置。
 * @param override 该 AI 应用的独立设置；缺省或非独立模式时跟随主应用默认
 */
export function resolveDownloadSettings(
  override?: ProfileDownloadSettings,
): EffectiveDownloadSettings {
  const global = getAppSettings()
  if (override?.mode === 'custom') {
    return {
      downloadDir: resolveSaveDirectory(override.downloadDir || global.downloadDir),
      downloadBehavior: override.downloadBehavior ?? global.downloadBehavior,
      source: 'profile',
    }
  }
  return {
    downloadDir: resolveSaveDirectory(global.downloadDir),
    downloadBehavior: global.downloadBehavior,
    source: 'global',
  }
}

/** 写回默认保存位置的作用域：独立设置写回该 AI 应用，跟随主应用的写回全局设置 */
export interface DownloadDefaultScope {
  /** 该 AI 应用当前的独立设置 */
  override?: ProfileDownloadSettings
  /** 写回该 AI 应用独立设置的入口；缺省表示只写回主应用全局设置 */
  saveOverride?: (next: ProfileDownloadSettings) => unknown
}

/**
 * 把用户选择的目录记为默认保存位置，并关闭后续询问。
 * 写回当前生效的那一层：AI 应用独立设置写回该 AI 应用，跟随主应用的写回全局设置。
 */
export async function rememberDownloadDefault(
  scope: DownloadDefaultScope,
  directory: string,
): Promise<void> {
  const effective = resolveDownloadSettings(scope.override)
  if (effective.source === 'profile' && scope.saveOverride) {
    await scope.saveOverride({
      mode: 'custom',
      downloadDir: directory,
      downloadBehavior: 'auto',
    })
    return
  }
  updateAppSettings({ downloadDir: directory, downloadBehavior: 'auto' })
}
