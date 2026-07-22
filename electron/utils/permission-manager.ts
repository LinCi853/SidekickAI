// electron/utils/permission-manager.ts — 统一权限管理
//
// 集中管理 macOS 辅助功能权限检测与申请、safeStorage 后端检测与降级策略。
// 跨平台：非 macOS 的辅助功能检查直接返回 true，safeStorage 不可用时提供 XOR 降级。

import { dialog, safeStorage, shell, systemPreferences } from 'electron'

/** 安全存储后端类型 */
export type StorageBackend = 'keychain' | 'libsecret' | 'dpapi' | 'fallback'

// ============================================================================
// macOS 辅助功能权限
// ============================================================================

/**
 * 检测 macOS 辅助功能权限是否已授权。
 * 非 macOS 平台直接返回 true（不需要此权限）。
 */
export function checkAccessibilityPermission(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

/**
 * 申请 macOS 辅助功能权限：先弹自定义 dialog 让用户确认，再打开系统设置。
 * 非 macOS 平台直接返回 true。
 * @returns 当前是否已授权（首次调用可能返回 false，用户需在系统设置中手动开启）
 */
export async function promptAccessibilityPermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const granted = checkAccessibilityPermission()
  if (!granted) {
    // 先弹 dialog 让用户选择是否前往系统设置（避免直接跳转，UX 更友好）
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '需要辅助功能权限',
      message: '全局热键和语音输入功能需要"辅助功能"权限。',
      detail:
        '请在"系统设置 > 隐私与安全性 > 辅助功能"中勾选本应用，' +
        '然后重新触发相关功能即可正常使用。',
      buttons: ['打开系统设置', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      )
    }
  }
  return granted
}

// ============================================================================
// safeStorage 后端检测与降级
// ============================================================================

/**
 * 获取当前平台的安全存储后端类型。
 * 用于 UI 展示和日志记录。
 */
export function getStorageBackend(): StorageBackend {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  // Linux：检查 safeStorage 是否可用（依赖 libsecret / gnome-keyring）
  try {
    if (safeStorage.isEncryptionAvailable()) return 'libsecret'
  } catch {
    // safeStorage 不可用
  }
  return 'fallback'
}

/**
 * 检测 safeStorage 是否可用。
 * Windows（DPAPI）和 macOS（Keychain）几乎总是可用；
 * Linux 需要 gnome-keyring 或 kwallet 服务运行。
 */
export function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

// ============================================================================
// XOR 降级加密（safeStorage 不可用时的兜底方案）
// ============================================================================

/**
 * XOR 降级加密密钥（固定值，仅用于 safeStorage 不可用时的兜底。
 * 安全性有限，但比明文存储好；配合文件权限 600 使用）。
 * 注意：此密钥不应更改，否则已加密的数据无法解密。
 */
const XOR_KEY = Buffer.from('ai-window-xor-fallback-v1', 'utf8')

/**
 * XOR 加密字符串（safeStorage 不可用时的降级方案）。
 * 返回 base64 编码的密文，前缀 'xor:' 以区分 safeStorage 密文。
 */
export function xorEncrypt(plain: string): string {
  const plainBuf = Buffer.from(plain, 'utf8')
  const result = Buffer.alloc(plainBuf.length)
  for (let i = 0; i < plainBuf.length; i++) {
    result[i] = plainBuf[i]! ^ XOR_KEY[i % XOR_KEY.length]!
  }
  return 'xor:' + result.toString('base64')
}

/**
 * XOR 解密字符串（识别 'xor:' 前缀的密文）。
 */
export function xorDecrypt(cipher: string): string {
  if (!cipher.startsWith('xor:')) {
    throw new Error('不是 XOR 降级密文（缺少 xor: 前缀）')
  }
  const encrypted = Buffer.from(cipher.slice(4), 'base64')
  const result = Buffer.alloc(encrypted.length)
  for (let i = 0; i < encrypted.length; i++) {
    result[i] = encrypted[i]! ^ XOR_KEY[i % XOR_KEY.length]!
  }
  return result.toString('utf8')
}
