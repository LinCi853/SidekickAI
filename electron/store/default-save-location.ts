// electron/store/default-save-location.ts —— 默认保存位置
//
// 主应用设置里的“下载目录”是全局唯一的默认保存位置，所有保存动作共用：
//   - 下载行为=自动保存到目录：文件直接落到该目录，不弹框
//   - 下载行为=每次询问，以及显式“另存为”：保存对话框默认打开在该目录
//   - 导出对话、资料原件等主应用内的保存动作同样以该目录为默认位置
// 未配置时回落到系统下载目录。

import path from 'node:path'
import { app } from 'electron'
import { getAppSettings } from './app-settings-repository.js'
import { safeDownloadFilename } from '../platform/security/download-path.js'

/** 把设置中的下载目录解析为可用的保存目录（空值回落到系统下载目录） */
export function resolveSaveDirectory(downloadDir: string | undefined | null): string {
  return downloadDir || app.getPath('downloads')
}

/** 当前生效的默认保存目录 */
export function defaultSaveDirectory(): string {
  return resolveSaveDirectory(getAppSettings().downloadDir)
}

/** 默认保存目录下的目标文件路径（文件名做安全清洗，避免越界或非法字符） */
export function defaultSavePath(filename: string): string {
  return path.join(defaultSaveDirectory(), safeDownloadFilename(filename))
}
