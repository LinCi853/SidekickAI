// electron/platform/window/win32-foreground.ts — Windows 前台窗口读写与自身工作集回收（原生桥）
//
// 把 user32 的 GetForegroundWindow / SetForegroundWindow 封装为毫秒级往返：
// 启动时复用经过校验的原生启动助手（开发环境可降级 PowerShell），之后每次
// 读/写前台只需一次 stdin/stdout 行交换，不再每次派生新进程（冷启动
// 300ms~1s，且 capture/restore 两个进程并发时完成顺序不可控）。
//
// 协议（行分隔，命令与响应都带请求 id，迟到响应按 id 丢弃）：
//   Node → PS:  G:<id>            读前台窗口句柄
//               S:<id>:<hwnd>     把指定窗口置前台（最小化则先 SW_RESTORE）
//               Q                 退出
//   PS → Node:  G:<id>:<hwnd>     读结果（hwnd=0 表示失败）
//               S:<id>:<0|1>      写结果
//               READY             Add-Type 完成（仅预热信号，不参与匹配）
//
// 降级：非 Windows / 进程拉起失败 / 请求超时 → 读返回 null、写返回 false，
// 调用方（focus-manager）据此跳过强制焦点恢复，交回系统自然激活。

import { spawn, type ChildProcess } from 'child_process'
import { app, type BrowserWindow } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  windowsStartupHelper,
  windowsStartupHelperAtDirectory,
} from '../../../packages/desktop-common/windows-startup-helper'
import { backgroundWindowForProcess } from '../../diagnostics/resident-process-ownership.js'

/** 常驻会话脚本：Add-Type 完成后按行读取 stdin 并分发 G/S/Q 命令 */
const BRIDGE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SidekickForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
Write-Output 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(':')
  if ($parts.Length -lt 2) { continue }
  if ($parts[0] -eq 'G') {
    $value = [SidekickForeground]::GetForegroundWindow().ToInt64()
    Write-Output ('G:' + $parts[1] + ':' + $value)
  } elseif ($parts[0] -eq 'S') {
    $h = [IntPtr]::new([int64]$parts[2])
    if ([SidekickForeground]::IsIconic($h)) { [SidekickForeground]::ShowWindow($h, 9) | Out-Null }
    # Alt 技巧：模拟一次 Alt 按下/抬起，解除前台锁定对 SetForegroundWindow 的拒绝
    [SidekickForeground]::keybd_event(0x12, 0, 0, 0)
    [SidekickForeground]::keybd_event(0x12, 0, 2, 0)
    $ok = [SidekickForeground]::SetForegroundWindow($h)
    if (-not $ok) {
      # AttachThreadInput 兜底：挂到当前前台线程输入队列后再抢前台
      $fg = [SidekickForeground]::GetForegroundWindow()
      $fgPid = 0
      $fgThread = [SidekickForeground]::GetWindowThreadProcessId($fg, [ref]$fgPid)
      $curThread = [SidekickForeground]::GetCurrentThreadId()
      $attached = $false
      if ($fgThread -ne 0 -and $fgThread -ne $curThread) {
        $attached = [SidekickForeground]::AttachThreadInput($fgThread, $curThread, $true)
      }
      [SidekickForeground]::BringWindowToTop($h) | Out-Null
      $ok = [SidekickForeground]::SetForegroundWindow($h)
      if ($attached) { [SidekickForeground]::AttachThreadInput($fgThread, $curThread, $false) | Out-Null }
    }
    if ($ok) { Write-Output ('S:' + $parts[1] + ':1') } else { Write-Output ('S:' + $parts[1] + ':0') }
  } elseif ($parts[0] -eq 'Q') {
    break
  }
}
`

let lastReclaimActivityAt = Date.now()
export function markForegroundActivity(): void {
  lastReclaimActivityAt = Date.now()
}

const REQUEST_TIMEOUT_MS = 2000

let child: ChildProcess | null = null
let stdoutBuffer = ''
let nextRequestId = 1
let disposed = false
const pending = new Map<
  number,
  { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }
>()

function handleLine(line: string): void {
  const [kind, idText, value] = line.replace(/\r$/, '').split(':')
  if (kind !== 'G' && kind !== 'S' && kind !== 'T') return
  const entry = pending.get(Number(idText))
  if (!entry) return
  pending.delete(Number(idText))
  clearTimeout(entry.timer)
  entry.resolve(value ?? null)
}

function failAllPending(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(null)
  }
  pending.clear()
}

/** 拉起常驻会话（幂等）；非 Windows / 已 dispose / 拉起失败返回 false */
function startBridge(): boolean {
  if (process.platform !== 'win32' || disposed) return false
  if (child) return true
  try {
    // -EncodedCommand（UTF-16LE Base64）传脚本，绕开命令行引号转义问题
    const encoded = Buffer.from(BRIDGE_SCRIPT, 'utf16le').toString('base64')
    const devCache = path.join(app.getAppPath(), 'build/native-startup')
    const resources = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'resources')
    let native = existsSync(path.join(resources, 'windows/SidekickStartup.exe'))
      ? windowsStartupHelper(resources, { operation: 'foreground-bridge' })
      : null
    if (!app.isPackaged && existsSync(path.join(devCache, 'SidekickStartup.exe')))
      native = windowsStartupHelperAtDirectory(devCache, { operation: 'foreground-bridge' })
    if (!native && app.isPackaged) throw new Error('Packaged foreground helper is missing')
    const proc = spawn(
      native?.executable ?? 'powershell.exe',
      native?.args ?? ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        windowsHide: true,
        // A detached native pipe server does not allocate a hidden conhost.
        // The explicit Q/kill cleanup and parent-identity guard still apply.
        detached: !!native,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    )
    child = proc
    stdoutBuffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        handleLine(stdoutBuffer.slice(0, newline))
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    const teardown = () => {
      if (child === proc) {
        child = null
        failAllPending()
      }
    }
    proc.on('exit', teardown)
    proc.on('error', teardown)
    return true
  } catch {
    child = null
    return false
  }
}

function request(
  kind: 'G' | 'S' | 'T',
  hwnd: number | string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!startBridge() || !child) {
      resolve(null)
      return
    }
    const id = nextRequestId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    const line = kind === 'G' ? `G:${id}\n` : `${kind}:${id}:${hwnd}\n`
    child.stdin?.write(line, (err) => {
      if (err) {
        clearTimeout(timer)
        pending.delete(id)
        resolve(null)
      }
    })
  })
}

/** 预热常驻会话（app ready 后调用一次，让首次读前台避开 Add-Type 冷启动） */
export function warmWin32ForegroundBridge(): void {
  startBridge()
}

/** 读当前前台窗口句柄；失败/超时/非 Windows 返回 null */
export async function getForegroundHandle(timeoutMs = REQUEST_TIMEOUT_MS): Promise<number | null> {
  const value = await request('G', 0, timeoutMs)
  if (value == null) return null
  const handle = Number(value)
  return Number.isFinite(handle) && handle > 0 ? handle : null
}

/** 把指定窗口置前台（最小化先还原）；失败/超时/非 Windows 返回 false */
export async function setForegroundHandle(
  hwnd: number,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  return (await request('S', hwnd, timeoutMs)) === '1'
}

/** 退出清理（app 退出时调用）：终止常驻会话并放弃全部在途请求 */
export function disposeWin32ForegroundBridge(): void {
  disposed = true
  const proc = child
  child = null
  failAllPending()
  if (!proc) return
  try {
    proc.stdin?.write('Q\n')
  } catch {
    /* ignore */
  }
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
}

export interface WorkingSetTrimResult {
  beforeBytes: number
  afterBytes: number
  durationMs: number
}
export async function trimWorkingSet(
  pid: number,
  creationTime: number,
  maxBytes: number,
  idleMs: number,
  backgroundWindow?: BrowserWindow,
): Promise<WorkingSetTrimResult | null> {
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(creationTime) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 48 * 1024 * 1024 ||
    idleMs < 15000
  )
    return null
  if (!backgroundWindow && Date.now() - lastReclaimActivityAt < idleMs) return null
  const metrics = app.getAppMetrics()
  const target = metrics.find(
    (metric) => metric.pid === pid && metric.creationTime === creationTime,
  )
  const browser = metrics.find((metric) => metric.type === 'Browser' && metric.pid === process.pid)
  if (!target || !browser) return null
  let handle: number | undefined
  if (backgroundWindow) {
    if (target.type !== 'Tab' || backgroundWindowForProcess(pid) !== backgroundWindow) return null
    try {
      const bytes = backgroundWindow.getNativeWindowHandle()
      handle = bytes.length >= 8 ? Number(bytes.readBigUInt64LE()) : bytes.readUInt32LE()
      if (!Number.isSafeInteger(handle) || handle <= 0) return null
    } catch {
      return null
    }
  } else if (Date.now() - lastReclaimActivityAt < idleMs) return null
  const args = [pid, creationTime, maxBytes, idleMs, browser.pid, browser.creationTime]
  if (handle !== undefined) args.push(handle)
  const value = await request('T', args.join(':'), REQUEST_TIMEOUT_MS)
  if (!value || value === '0') return null
  const values = value.split(',').map(Number)
  if (values.length !== 3 || values.some((n) => !Number.isFinite(n) || n < 0)) return null
  return { beforeBytes: values[0], afterBytes: values[1], durationMs: values[2] }
}
