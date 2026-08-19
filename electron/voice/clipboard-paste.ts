// electron/voice/clipboard-paste.ts — 后台语音上屏：剪贴板备份/恢复 + 模拟 Ctrl+V
//
// 从 main.ts 抽离：
//   - ClipboardSnapshot：剪贴板内容快照类型（文本/HTML/RTF/图片）
//   - backupClipboard / restoreClipboard：备份与恢复用户原剪贴板内容
//   - pasteTextToExternalApp：写入识别文本 → 模拟 Ctrl+V → 延迟恢复原剪贴板
//   - simulateCtrlV：跨平台模拟粘贴键（委托 platform-actions.simulatePaste）
//
// 剪贴板恢复定时器（clipboardRestoreTimer）保留本文件，
// lifecycle.ts 退出清理通过 clearClipboardRestoreTimer() 暴露。

import { showNotification } from '../notify.js'
import {
  simulatePaste,
  typeText,
  insertTextLayered,
  ERR_MAC_ACCESSIBILITY_DENIED,
} from '../utils/platform-actions.js'
import type { InsertTextResult } from '../utils/platform-actions.js'

/** 剪贴板恢复定时器（后台粘贴后延迟恢复用户原剪贴板内容） */
let clipboardRestoreTimer: NodeJS.Timeout | null = null

/**
 * 模拟 Ctrl+V / Cmd+V 粘贴到当前前台外部应用。
 * 跨平台实现委托给 platform-actions.simulatePaste：
 *   - Windows: PowerShell SendKeys（原实现）
 *   - macOS:   osascript System Events（需辅助功能权限）
 *   - Linux:   xdotool / wtype / xclip 降级链
 *
 * 保持 fire-and-forget 语义（与原 exec 回调一致）。失败时通知用户手动粘贴；
 * macOS 权限缺失已由 simulatePaste 内部弹 dialog 提示，此处跳过重复通知。
 *
 * 注意：调用方必须确保本应用窗口已失焦（前台为外部应用），且在调用前已隐藏录音指示器，
 * 否则粘贴键会被自身窗口截获。
 */
function simulateCtrlV(): void {
  simulatePaste().catch((err: unknown) => {
    console.error('[voice] 模拟粘贴失败:', err)
    if ((err as Error & { code?: string }).code === ERR_MAC_ACCESSIBILITY_DENIED) {
      // macOS 权限缺失：simulatePaste 已弹 dialog 引导授权，不再重复通知
      return
    }
    showNotification('语音已识别', '请在目标窗口按 Ctrl+V 粘贴')
  })
}

/**
 * 剪贴板内容快照（用于后台粘贴后恢复用户原内容，避免永久覆盖）。
 * 仅备份常见格式：纯文本、HTML、RTF、图片。读取失败的字段留空/标记为不存在。
 */
export interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  hasImage: boolean
  image: Electron.NativeImage | null
}

/**
 * 备份当前系统剪贴板的常见格式内容。
 * 任何格式读取异常都不影响其他格式的备份。
 */
function backupClipboard(): ClipboardSnapshot {
  const { clipboard } = require('electron') as typeof import('electron')
  const snapshot: ClipboardSnapshot = { text: '', html: '', rtf: '', hasImage: false, image: null }
  try {
    snapshot.text = clipboard.readText() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板文本失败:', e)
  }
  try {
    snapshot.html = clipboard.readHTML() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板 HTML 失败:', e)
  }
  try {
    snapshot.rtf = clipboard.readRTF() || ''
  } catch (e) {
    console.warn('[voice] 备份剪贴板 RTF 失败:', e)
  }
  try {
    const img = clipboard.readImage()
    snapshot.hasImage = !img.isEmpty()
    snapshot.image = snapshot.hasImage ? img : null
  } catch (e) {
    console.warn('[voice] 备份剪贴板图片失败:', e)
  }
  return snapshot
}

/**
 * 恢复之前备份的剪贴板内容。
 * 按原格式顺序写回；任何格式写回失败仅记录日志，不影响后续格式。
 * 注意：恢复时先把 text 写回，再覆盖 html/rtf/image，确保格式与备份前一致。
 */
function restoreClipboard(snapshot: ClipboardSnapshot): void {
  const { clipboard } = require('electron') as typeof import('electron')
  try {
    clipboard.writeText(snapshot.text)
  } catch (e) {
    console.error('[voice] 恢复剪贴板文本失败:', e)
  }
  if (snapshot.html) {
    try {
      clipboard.writeHTML(snapshot.html)
    } catch (e) {
      console.error('[voice] 恢复剪贴板 HTML 失败:', e)
    }
  }
  if (snapshot.rtf) {
    try {
      clipboard.writeRTF(snapshot.rtf)
    } catch (e) {
      console.error('[voice] 恢复剪贴板 RTF 失败:', e)
    }
  }
  if (snapshot.hasImage && snapshot.image) {
    try {
      clipboard.writeImage(snapshot.image)
    } catch (e) {
      console.error('[voice] 恢复剪贴板图片失败:', e)
    }
  }
}

/**
 * 后台粘贴上屏：把识别文本粘贴到当前前台外部应用。
 * 流程（标准语音输入法行为 + 剪贴板保护）：
 *   1. 备份用户当前剪贴板内容（文本/HTML/RTF/图片）
 *   2. 写入识别文本到剪贴板
 *   3. 延迟 150ms 后模拟 Ctrl+V（等待本应用窗口完全失焦，避免被自身截获）
 *   4. 再延迟 500ms 后静默恢复原剪贴板内容
 * 若恢复失败，至少保留日志，避免用户原内容永久丢失。
 */
export function pasteTextToExternalApp(text: string): void {
  const { clipboard } = require('electron') as typeof import('electron')
  // 1. 备份原剪贴板内容
  const snapshot = backupClipboard()
  console.log('[voice] 后台模式：已备份剪贴板原内容，准备写入识别文本')
  // 2. 写入识别文本
  try {
    clipboard.writeText(text)
  } catch (e) {
    console.error('[voice] 写入剪贴板失败:', e)
    return
  }
  // 取消任何挂起的恢复定时器
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer)
    clipboardRestoreTimer = null
  }
  // 3. 延迟 150ms 模拟 Ctrl+V（等待窗口失焦）
  setTimeout(() => {
    simulateCtrlV()
    // 4. 再延迟 500ms 恢复原剪贴板内容（确保外部应用已读取剪贴板完成粘贴）
    clipboardRestoreTimer = setTimeout(() => {
      clipboardRestoreTimer = null
      try {
        restoreClipboard(snapshot)
        console.log('[voice] 剪贴板原内容已恢复')
      } catch (e) {
        console.error('[voice] 剪贴板恢复失败，原内容可能已被覆盖:', e)
      }
    }, 500)
  }, 150)
}

/** 清理挂起的剪贴板恢复定时器（lifecycle.ts 退出清理时调用） */
export function clearClipboardRestoreTimer(): void {
  if (clipboardRestoreTimer) {
    clearTimeout(clipboardRestoreTimer)
    clipboardRestoreTimer = null
  }
}

/**
 * 直接键入文本到当前前台外部应用（不修改剪贴板）。
 * 使用平台原生键盘模拟逐字符输入，光标在哪个输入框就输入到哪里。
 *
 * 比 clipboard+Ctrl+V 模式更可靠：
 *   - 不会覆盖用户剪贴板内容
 *   - 不需要等待窗口失焦
 *   - 在任何支持键盘输入的应用中都能工作
 */
export async function typeTextToExternalApp(text: string): Promise<void> {
  try {
    await typeText(text)
    console.log('[voice] 直接键入模式：文本已输入到前台应用')
  } catch (err) {
    console.error('[voice] 直接键入失败:', err)
    if ((err as Error & { code?: string }).code === ERR_MAC_ACCESSIBILITY_DENIED) {
      return // macOS 权限缺失，已弹窗提示
    }
    showNotification('语音已识别', '自动输入失败，请手动粘贴')
  }
}

/**
 * 分层降级上屏（推荐方案）
 * 尝试顺序：UI Automation → SendInput → 剪贴板
 * 返回实际使用的上屏方式
 */
export async function insertTextToExternalApp(text: string): Promise<InsertTextResult> {
  const result = await insertTextLayered(text, {
    backup: backupClipboard,
    write: (t) => {
      const { clipboard } = require('electron') as typeof import('electron')
      clipboard.writeText(t)
    },
    restore: (snapshot) => restoreClipboard(snapshot as ClipboardSnapshot),
  })

  console.log(`[voice] 分层上屏结果: method=${result.method}, success=${result.success}`)
  if (!result.success) {
    showNotification('语音已识别', '自动输入失败，请手动粘贴')
  }
  return result
}
