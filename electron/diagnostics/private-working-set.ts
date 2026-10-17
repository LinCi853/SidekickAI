// electron/diagnostics/private-working-set.ts — Windows 专用工作集读取
//
// 与任务管理器进程页「内存」列（活动的专用工作集）对齐。
// Win32_PerfRawData_PerfProc_Process.WorkingSetPrivate 即 Process\Working Set - Private。
// 非 Windows 或查询失败返回空 Map，由调用方决定是否回退到含共享页工作集。

import { execFile } from 'node:child_process'

/** 单次查询超时；开发设置页约 2 秒刷新，失败不阻塞列表。 */
const QUERY_TIMEOUT_MS = 4000

const SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ids = @{}
foreach ($token in ('__PIDS__' -split ',')) {
  $n = 0
  if ([int]::TryParse($token, [ref]$n)) { $ids[$n] = $true }
}
if ($ids.Count -eq 0) { exit 0 }
Get-CimInstance -ClassName Win32_PerfRawData_PerfProc_Process -ErrorAction Stop |
  Where-Object { $ids.ContainsKey([int]$_.IDProcess) } |
  ForEach-Object { Write-Output (([string][int]$_.IDProcess) + '=' + [string][long]$_.WorkingSetPrivate) }
`

function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 读取各 PID 的专用工作集（字节）。缺失的 PID 不会出现在结果里。
 * 仅 Windows；其它平台或失败时返回空 Map。
 */
export async function readPrivateWorkingSetBytes(pids: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  const unique = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))]
  if (process.platform !== 'win32' || unique.length === 0) return result

  try {
    const script = SCRIPT.replace('__PIDS__', unique.join(','))
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)],
        { timeout: QUERY_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr: String(stderr ?? '') }))
          else resolve({ stdout: String(stdout) })
        },
      )
    })

    for (const line of stdout.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const pid = Number(line.slice(0, eq).trim())
      const bytes = Number(line.slice(eq + 1).trim())
      if (Number.isInteger(pid) && pid > 0 && Number.isFinite(bytes) && bytes >= 0) {
        result.set(pid, bytes)
      }
    }
  } catch {
    return new Map()
  }
  return result
}
