// electron/utils/win32-foreground.ts — Windows 前台窗口读写（常驻 PowerShell 桥）
//
// 把 user32 的 GetForegroundWindow / SetForegroundWindow 封装为毫秒级往返：
// 启动时拉起一个常驻 PowerShell 会话（Add-Type 预载 P/Invoke），之后每次
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
    $ok = [SidekickForeground]::SetForegroundWindow($h)
    if ($ok) { Write-Output ('S:' + $parts[1] + ':1') } else { Write-Output ('S:' + $parts[1] + ':0') }
  } elseif ($parts[0] -eq 'Q') {
    break
  }
}
`

const REQUEST_TIMEOUT_MS = 2000

let child: ChildProcess | null = null
let stdoutBuffer = ''
let nextRequestId = 1
let disposed = false
const pending = new Map<number, { resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }>()

function handleLine(line: string): void {
  const [kind, idText, value] = line.replace(/\r$/, '').split(':')
  if (kind !== 'G' && kind !== 'S') return
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
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
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

function request(kind: 'G' | 'S', hwnd: number, timeoutMs: number): Promise<string | null> {
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
    const line = kind === 'G' ? `G:${id}\n` : `S:${id}:${hwnd}\n`
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
export async function setForegroundHandle(hwnd: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<boolean> {
  return (await request('S', hwnd, timeoutMs)) === '1'
}

/** 退出清理（app 退出时调用）：终止常驻会话并放弃全部在途请求 */
export function disposeWin32ForegroundBridge(): void {
  disposed = true
  const proc = child
  child = null
  failAllPending()
  if (!proc) return
  try { proc.stdin?.write('Q\n') } catch { /* ignore */ }
  try { proc.kill() } catch { /* ignore */ }
}
