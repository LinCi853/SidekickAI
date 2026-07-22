// electron/utils/platform-info.ts — 平台能力查询接口
//
// 提供当前运行平台的能力矩阵（安全存储、全局快捷键、辅助功能权限等），
// 通过 IPC 暴露给渲染进程，设置页可显示当前权限状态。

import { ipcMain, safeStorage, systemPreferences } from 'electron'
import { execSync } from 'child_process'
import {
  checkAccessibilityPermission,
  getStorageBackend,
  type StorageBackend,
} from './permission-manager.js'

/** 平台能力矩阵 */
export interface PlatformCapabilities {
  platform: 'win32' | 'darwin' | 'linux'
  arch: string
  hasAccessibility: boolean
  hasMicrophone: boolean
  hasSecureStorage: boolean
  hasGlobalShortcut: boolean
  hasLowLevelHook: boolean
  storageBackend: StorageBackend
  isWayland: boolean
}

/** 检测 Linux 是否运行在 Wayland 会话下 */
function detectWayland(): boolean {
  if (process.platform !== 'linux') return false
  // XDG_SESSION_TYPE=wayland 是最常见的检测方式
  if (process.env.XDG_SESSION_TYPE === 'wayland') return true
  // 兜底：WAYLAND_DISPLAY 环境变量存在
  return !!process.env.WAYLAND_DISPLAY
}

/** 检测 Linux libsecret（gnome-keyring / kwallet）是否可用 */
function detectLibsecret(): boolean {
  if (process.platform !== 'linux') return false
  try {
    // secret-tool 是 libsecret 的 CLI 工具，存在即说明 libsecret 可用
    execSync('which secret-tool', { timeout: 3000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * 获取当前平台的能力矩阵。
 * macOS 辅助功能权限和麦克风权限需要运行时检测。
 */
export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const platform = process.platform as 'win32' | 'darwin' | 'linux'

  // 辅助功能权限：macOS 需要运行时检测，其它平台默认有
  const hasAccessibility = checkAccessibilityPermission()

  // 麦克风权限：macOS 需要运行时检测
  let hasMicrophone = true
  if (platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone')
      hasMicrophone = status === 'granted'
    } catch {
      hasMicrophone = false
    }
  }

  // 安全存储可用性
  let hasSecureStorage = false
  try {
    hasSecureStorage = safeStorage.isEncryptionAvailable()
  } catch {
    hasSecureStorage = false
  }
  // Linux 上 safeStorage 可能因缺少 libsecret 而不可用
  if (!hasSecureStorage && platform === 'linux') {
    hasSecureStorage = detectLibsecret()
  }

  const storageBackend = getStorageBackend()
  const isWayland = detectWayland()

  return {
    platform,
    arch: process.arch,
    hasAccessibility,
    hasMicrophone,
    hasSecureStorage,
    hasGlobalShortcut: true, // Electron globalShortcut 三平台均可用
    hasLowLevelHook: !isWayland, // uiohook 在 Wayland 下不可用
    storageBackend,
    isWayland,
  }
}

/** 注册平台能力查询 IPC（必须在 app.whenReady 后调用） */
export function registerPlatformInfoIPC(): void {
  ipcMain.handle('platform:capabilities', () => getPlatformCapabilities())
}
