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
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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

/**
 * 逐字符键入文本到当前前台应用（不修改剪贴板）。
 * 使用平台原生方式模拟键盘输入：
 *   - Windows: PowerShell SendKeys（逐字符发送）
 *   - macOS:   osascript keystroke（逐字符）
 *   - Linux:   xdotool type
 *
 * 适用于需要直接输入到第三方应用光标位置的场景。
 * 比剪贴板+Ctrl+V更可靠，不会覆盖用户剪贴板内容。
 */
export async function typeText(text: string): Promise<void> {
  const platform = process.platform

  if (platform === 'win32') {
    // Windows: 使用 PowerShell SendKeys 逐段发送（转义特殊字符）
    // SendKeys 特殊字符：+^%~(){}[]
    const escaped = text
      .replace(/([+^%~(){}[\]])/g, '{$1}')
      .replace(/\n/g, '~')
      .replace(/\r/g, '')
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')`
    try {
      await execAsync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`)
      console.log('[platform-actions] Windows SendKeys type 成功')
    } catch (e) {
      console.error('[platform-actions] Windows SendKeys type 失败:', e)
      throw e
    }
    return
  }

  if (platform === 'darwin') {
    if (!checkAccessibilityPermission()) {
      await promptAccessibilityPermission()
      if (!checkAccessibilityPermission()) {
        const err = new Error('macOS 辅助功能权限未授权，无法键入文本') as Error & { code?: string }
        err.code = ERR_MAC_ACCESSIBILITY_DENIED
        throw err
      }
    }
    // macOS: osascript keystroke，转义双引号和反斜杠
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `tell application "System Events" to keystroke "${escaped}"`
    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`)
      console.log('[platform-actions] macOS osascript type 成功')
    } catch (e) {
      console.error('[platform-actions] macOS osascript type 失败:', e)
      throw e
    }
    return
  }

  // Linux: xdotool type
  try {
    const escaped = text.replace(/'/g, "'\\''")
    await execAsync(`xdotool type --clearmodifiers '${escaped}'`)
    console.log('[platform-actions] Linux xdotool type 成功')
    return
  } catch (e) {
    console.warn('[platform-actions] xdotool type 失败:', e)
  }

  throw new Error('Linux 文本键入失败：xdotool 不可用')
}

/**
 * 获取当前前台窗口的原生句柄（HWND on Windows）。
 * 用于在显示主窗口前记住之前聚焦的外部应用，隐藏主窗口后恢复。
 *
 * - Windows: 使用 user32.dll GetForegroundWindow
 * - macOS/Linux: 暂不支持，返回 null
 */
export function getForegroundWindowHandle(): number | null {
  if (process.platform !== 'win32') return null
  try {
    // 使用 koffi 调用 Windows API（koffi 是 Electron 内可用的 FFI 库）
    // 如果 koffi 不可用，降级使用 PowerShell
    const { execSync } = require('child_process')
    const result = execSync(
      'powershell -NoProfile -Command "Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); }\'; [Win32]::GetForegroundWindow().ToInt64()"',
      { encoding: 'utf-8', timeout: 2000 }
    ).trim()
    const handle = parseInt(result, 10)
    return isNaN(handle) ? null : handle
  } catch (e) {
    console.warn('[platform-actions] 获取前台窗口句柄失败:', e)
    return null
  }
}

/**
 * 将指定句柄的窗口设置为前台（HWND on Windows）。
 * 用于隐藏主窗口后恢复之前聚焦的外部应用。
 *
 * - Windows: 使用 user32.dll SetForegroundWindow + ShowWindow
 * - macOS/Linux: 暂不支持
 */
export function setForegroundWindowByHandle(handle: number): boolean {
  if (process.platform !== 'win32') return false
  try {
    const { execSync } = require('child_process')
    const script = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
}
'
$hwnd = [IntPtr]::new(${handle})
if ([Win32]::IsIconic($hwnd)) {
  [Win32]::ShowWindow($hwnd, 9) # SW_RESTORE
}
[Win32]::SetForegroundWindow($hwnd)
`
    execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { timeout: 2000 })
    console.log('[platform-actions] 恢复前台窗口成功:', handle)
    return true
  } catch (e) {
    console.warn('[platform-actions] 恢复前台窗口失败:', e)
    return false
  }
}

/**
 * 上屏结果类型
 */
export interface InsertTextResult {
  success: boolean
  method: 'uia' | 'sendinput' | 'clipboard' | 'none'
  error?: string
}

/**
 * 分层降级文本上屏（首选方案）
 * 尝试顺序：UI Automation → SendInput → 剪贴板
 *
 * @param text 要插入的文本
 * @param clipboardBackup 剪贴板备份/恢复函数（由调用方提供，避免循环依赖）
 */
export async function insertTextLayered(
  text: string,
  clipboardBackup?: {
    backup: () => unknown
    write: (text: string) => void
    restore: (snapshot: unknown) => void
  }
): Promise<InsertTextResult> {
  if (process.platform !== 'win32') {
    // 非 Windows：降级到剪贴板
    return insertTextViaClipboard(text, clipboardBackup)
  }

  // 第一层：UI Automation
  try {
    const uiaResult = await insertTextViaUIA(text)
    if (uiaResult.success) {
      console.log('[platform-actions] UI Automation 上屏成功')
      return uiaResult
    }
    console.log('[platform-actions] UI Automation 不可用，降级到 SendInput')
  } catch (e) {
    console.warn('[platform-actions] UI Automation 失败:', e)
  }

  // 第二层：SendInput
  try {
    const siResult = await insertTextViaSendInput(text)
    if (siResult.success) {
      console.log('[platform-actions] SendInput 上屏成功')
      return siResult
    }
    console.log('[platform-actions] SendInput 失败，降级到剪贴板')
  } catch (e) {
    console.warn('[platform-actions] SendInput 失败:', e)
  }

  // 第三层：剪贴板
  return insertTextViaClipboard(text, clipboardBackup)
}

/**
 * 写入 UTF-8 临时文件并返回路径；调用方负责 finally 删除。
 * 用于把「脚本」和「待上屏文本」分开传递，避免 PowerShell/cmd 多层转义破坏中文与引号。
 */
function writeTempFile(prefix: string, content: string, withBom = false): string {
  const file = path.join(
    os.tmpdir(),
    `sidekick-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.writeFileSync(file, withBom ? '﻿' + content : content, 'utf8')
  return file
}

/**
 * 通过临时 .ps1 执行 PowerShell，规避 -Command 引号地狱。
 */
async function runPowerShellFile(script: string, timeout: number): Promise<string> {
  const scriptFile = writeTempFile('ps', script, true)
  try {
    const result = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`,
      { timeout, windowsHide: true },
    )
    return result.stdout || ''
  } finally {
    try {
      fs.unlinkSync(scriptFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * UI Automation 方式插入文本
 * 通过 COM 接口直接操作焦点控件的文本。
 * 文本经临时文件传入，脚本内显式加载 UIAutomation 程序集。
 */
async function insertTextViaUIA(text: string): Promise<InsertTextResult> {
  const textFile = writeTempFile('uia-text', text)
  const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $text = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}')
  if ([string]::IsNullOrEmpty($text)) { throw 'Empty text payload' }

  $uia = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $uia) { throw 'No focused element' }

  $pattern = $uia.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -eq $pattern) { throw 'No ValuePattern' }

  $pattern.SetValue($text)
  $verify = $pattern.Current.Value
  if ($verify -ne $text) { throw "UIA verify failed: got '$verify'" }
  Write-Output 'OK'
} catch {
  Write-Output ('FAIL: ' + $_.Exception.Message)
}
`
  try {
    const stdout = await runPowerShellFile(psScript, 4000)
    if (stdout.trim() === 'OK') {
      return { success: true, method: 'uia' }
    }
    return { success: false, method: 'uia', error: stdout.trim() || 'UIA no output' }
  } catch (e) {
    return { success: false, method: 'uia', error: String(e) }
  } finally {
    try {
      fs.unlinkSync(textFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * SendInput 方式插入文本（Unicode 模式）
 * 逐字符发送 Unicode 键码。C# 类型与文本都走临时文件，避免 Add-Type 字符串被 shell 转义破坏。
 */
async function insertTextViaSendInput(text: string): Promise<InsertTextResult> {
  const textFile = writeTempFile('si-text', text)
  const psScript = `
$ErrorActionPreference = 'Stop'
# 某些机器 LIB 含失效的 VS 路径，Add-Type 会把警告当错误而编译失败
if ($env:LIB) {
  $env:LIB = ((@($env:LIB -split ';')) | Where-Object { $_ -and (Test-Path $_) }) -join ';'
}
$text = [System.IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}')
if ([string]::IsNullOrEmpty($text)) { throw 'Empty text payload' }

$src = @'
using System;
using System.Runtime.InteropServices;

public class InputSender {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  public static void TypeText(string text) {
    foreach (char c in text) {
      INPUT down = new INPUT();
      down.type = INPUT_KEYBOARD;
      down.U.ki.wScan = c;
      down.U.ki.dwFlags = KEYEVENTF_UNICODE;

      INPUT up = new INPUT();
      up.type = INPUT_KEYBOARD;
      up.U.ki.wScan = c;
      up.U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

      INPUT[] inputs = new INPUT[] { down, up };
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
'@

if (-not ('InputSender' -as [type])) {
  Add-Type -TypeDefinition $src -Language CSharp
}

[InputSender]::TypeText($text)
Write-Output 'OK'
`
  try {
    const stdout = await runPowerShellFile(psScript, 8000)
    if (stdout.trim() === 'OK') {
      return { success: true, method: 'sendinput' }
    }
    return { success: false, method: 'sendinput', error: stdout.trim() || 'SendInput no output' }
  } catch (e) {
    return { success: false, method: 'sendinput', error: String(e) }
  } finally {
    try {
      fs.unlinkSync(textFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 剪贴板方式插入文本（兜底方案）
 */
function insertTextViaClipboard(
  text: string,
  clipboardBackup?: {
    backup: () => unknown
    write: (text: string) => void
    restore: (snapshot: unknown) => void
  }
): InsertTextResult {
  if (!clipboardBackup) {
    return { success: false, method: 'clipboard', error: 'No clipboard backup provided' }
  }

  try {
    const snapshot = clipboardBackup.backup()
    clipboardBackup.write(text)

    // 延迟后模拟 Ctrl+V（等 OS 剪贴板就绪 + 本窗口失焦）
    setTimeout(() => {
      simulatePaste()
        .then(() => {
          console.log('[platform-actions] 剪贴板模式 Ctrl+V 已触发')
        })
        .catch(e => {
          console.error('[platform-actions] 剪贴板模式 Ctrl+V 失败:', e)
        })
      // 再延迟恢复剪贴板，确保外部应用已完成粘贴读取
      setTimeout(() => {
        try {
          clipboardBackup.restore(snapshot)
          console.log('[platform-actions] 剪贴板已恢复')
        } catch (e) {
          console.error('[platform-actions] 恢复剪贴板失败:', e)
        }
      }, 500)
    }, 200)

    return { success: true, method: 'clipboard' }
  } catch (e) {
    return { success: false, method: 'clipboard', error: String(e) }
  }
}
