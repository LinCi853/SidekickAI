// electron/utils/platform-actions.ts — 跨平台系统动作封装
//
// 将 Windows 专属的模拟按键、剪贴板上屏等动作改造为带平台判断的跨平台实现。
//   Windows: PowerShell SendKeys（保留原行为，来自 main.ts 的 simulateCtrlV）
//   macOS:   osascript System Events（需"辅助功能"权限）
//   Linux:   xdotool key ctrl+v → wtype → xclip + xdotool type 降级链
//
// 设计原则：本模块只负责"执行平台动作 + 抛错"，不弹业务通知。
// 调用方（main.ts）在 catch 中决定是否提示用户手动粘贴（剪贴板已有内容）。

import { exec } from 'child_process'
import { promisify } from 'util'
import {
  checkAccessibilityPermission,
  promptAccessibilityPermission,
} from './permission-manager.js'

/** 错误码：macOS 辅助功能权限未授权。调用方可据此跳过重复的"手动粘贴"通知。 */
export const ERR_MAC_ACCESSIBILITY_DENIED = 'MAC_ACCESSIBILITY_DENIED'

/**
 * promisified exec：对齐 audio/capture.ts 的 promisify(execFile) 约定。
 * resolve { stdout, stderr }；reject 时 err 自带 .stdout/.stderr（Node 内置保证）。
 * 替换原手写 Promise wrapper，消除 Parameters<typeof exec>[1] 重载类型脆弱性。
 */
const execAsync = promisify(exec)

/**
 * 模拟"Ctrl+V / Cmd+V"粘贴到当前前台应用。
 * 调用方必须确保本应用窗口已失焦（前台为外部应用），且已在调用前把识别文本写入剪贴板。
 *
 * - Windows: PowerShell SendKeys::SendWait('^v')（保留原实现）
 * - macOS:   osascript keystroke "v" using {command down}；首次调用前检测辅助功能权限，
 *            未授权时抛 code=ERR_MAC_ACCESSIBILITY_DENIED
 * - Linux:   X11 优先 xdotool key ctrl+v；Wayland 或 xdotool 失败时降级 wtype；
 *            再降级 xclip + xdotool type
 *
 * 失败时抛错；调用方可在 catch 中提示用户手动 Ctrl+V（剪贴板已有内容）。
 */
export async function simulatePaste(): Promise<void> {
  const platform = process.platform

  if (platform === 'win32') {
    // 保留原 PowerShell SendKeys 实现（来自 main.ts simulateCtrlV）
    const psScript =
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
    try {
      await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`)
      console.log('[platform-actions] Windows SendKeys Ctrl+V 成功')
    } catch (e) {
      console.error('[platform-actions] Windows SendKeys Ctrl+V 失败:', e)
      throw e
    }
    return
  }

  if (platform === 'darwin') {
    // 复用 permission-manager.ts 的规范权限函数（已被 hotkey/manager.ts、main.ts、
    // platform-info.ts 调用），避免 D2 重复实现 macOS 辅助功能检测/申请逻辑。
    if (!checkAccessibilityPermission()) {
      // 触发系统授权弹窗 + 打开系统设置（非 darwin 平台此函数直接返回 true）
      await promptAccessibilityPermission()
      // 授权后仍需复查；仍未授权则抛错让调用方降级（main.ts 按 code 短路通知）
      if (!checkAccessibilityPermission()) {
        const err = new Error('macOS 辅助功能权限未授权，无法自动粘贴') as Error & {
          code?: string
        }
        err.code = ERR_MAC_ACCESSIBILITY_DENIED
        throw err
      }
    }
    const script = 'tell application "System Events" to keystroke "v" using {command down}'
    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`)
      console.log('[platform-actions] macOS osascript Cmd+V 成功')
    } catch (e) {
      console.error('[platform-actions] macOS osascript Cmd+V 失败:', e)
      throw e
    }
    return
  }

  // Linux
  const sessionType = (process.env.XDG_SESSION_TYPE || '').toLowerCase()
  const isWayland = sessionType === 'wayland'

  // X11：优先 xdotool key ctrl+v
  if (!isWayland) {
    try {
      await execAsync('xdotool key ctrl+v')
      console.log('[platform-actions] Linux xdotool Ctrl+V 成功')
      return
    } catch (e) {
      console.warn('[platform-actions] xdotool 失败，尝试降级:', e)
    }
  }

  // Wayland 或 xdotool 不可用：尝试 wtype
  try {
    await execAsync('wtype -k ctrl+v')
    console.log('[platform-actions] Linux wtype Ctrl+V 成功')
    return
  } catch (e) {
    console.warn('[platform-actions] wtype 不可用或失败:', e)
  }

  // 最终降级：xclip 读剪贴板 + xdotool type 键入（仅 X11 可用）
  if (!isWayland) {
    try {
      await execAsync('xdotool type --clearmodifiers "$(xclip -o -selection clipboard)"')
      console.log('[platform-actions] Linux xclip+xdotool type 成功')
      return
    } catch (e) {
      console.error('[platform-actions] xclip+xdotool type 失败:', e)
    }
  }

  throw new Error(
    'Linux 粘贴模拟失败：未找到可用的 xdotool / wtype（请安装对应工具或手动 Ctrl+V）',
  )
}

/**
 * 平台动作统一出口。后续可扩展：simulateCopy、openSystemSettings 等。
 */
export const platformActions = {
  simulatePaste,
}
