// electron/utils/process-guard.ts — 进程冲突检测与清理
//
// 用途：
//   1. 便携版启动时检测残留的 SidekickAI.exe 进程（如上一个实例崩溃后残留）
//   2. 提供"一键清理"功能，避免文件锁冲突或单实例锁失效
//
// 注意：
//   - 单实例锁（requestSingleInstanceLock）已处理同 userData 路径的重复启动
//   - 本模块处理跨 userData 路径的残留进程（如安装版 + 便携版同时运行）
//   - 仅 Windows 平台有效（其他平台直接返回空数组）

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface ProcessInfo {
  pid: number
  name: string
  /** 内存占用（KB），可能为 undefined（解析失败时） */
  memUsage?: number
}

/**
 * 检测当前系统中所有 SidekickAI.exe 进程（排除当前进程）。
 * 仅 Windows 平台有效，其他平台返回空数组。
 *
 * @returns 残留进程列表（排除当前 process.pid）
 */
export async function detectResidualProcesses(): Promise<ProcessInfo[]> {
  if (process.platform !== 'win32') return []

  try {
    // tasklist 输出 CSV 格式：映像名称,PID,会话名,会话#,内存使用
    const { stdout } = await execAsync(
      'tasklist /FI "IMAGENAME eq SidekickAI.exe" /NH /FO CSV',
      { windowsHide: true, timeout: 5000 },
    )

    const currentPid = process.pid
    const processes: ProcessInfo[] = []
    const lines = stdout.split('\n').filter((l) => l.trim())

    for (const line of lines) {
      // CSV 格式："SidekickAI.exe","1234","Console","1","12,345 K"
      const match = line.match(/"([^"]+)","(\d+)","([^"]+)","(\d+)","([\d,]+)\s*K"/)
      if (!match) continue
      const name = match[1]
      const pid = parseInt(match[2], 10)
      const memUsage = parseInt(match[5].replace(/,/g, ''), 10)

      if (!Number.isFinite(pid) || pid === currentPid) continue
      processes.push({ pid, name, memUsage })
    }

    return processes
  } catch (err) {
    // tasklist 失败（如命令不存在或超时）：静默返回空数组
    console.warn('[process-guard] detectResidualProcesses 失败:', err)
    return []
  }
}

/**
 * 杀死指定的进程（按 PID）。
 * 仅 Windows 平台有效。
 *
 * @param pids 要杀死的进程 PID 列表
 * @returns 成功杀死的 PID 列表
 */
export async function killProcesses(pids: number[]): Promise<number[]> {
  if (process.platform !== 'win32' || pids.length === 0) return []

  const killed: number[] = []
  for (const pid of pids) {
    try {
      await execAsync(`taskkill /F /PID ${pid}`, { windowsHide: true, timeout: 5000 })
      killed.push(pid)
    } catch (err) {
      console.warn(`[process-guard] 杀死进程 ${pid} 失败:`, err)
    }
  }
  return killed
}

/**
 * 杀死所有 SidekickAI.exe 进程（排除当前进程）。
 * 等同于 detectResidualProcesses + killProcesses。
 *
 * @returns 成功杀死的 PID 列表
 */
export async function killAllResidualProcesses(): Promise<number[]> {
  const residuals = await detectResidualProcesses()
  return killProcesses(residuals.map((p) => p.pid))
}
