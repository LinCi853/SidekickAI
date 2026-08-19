// electron/utils/cursor.ts — 系统光标重置（云游戏备用方案）
//
// 指针锁定（Pointer Lock）不可用时，云游戏 FPS 场景需要「光标持续居中」：
// 页面隐藏光标（cursor: none）+ mousemove 计算相对位移，再把系统光标
// 重置回窗口中心。Electron 没有直接设置光标坐标的 API，这里用 PowerShell
// 调用 user32.SetCursorPos 实现（Windows 专用；macOS/Linux 返回 not-supported）。
//
// 注意：PowerShell 子进程有约 100ms 启动开销，调用方应节流（建议 ≤10Hz），
// 指针锁定可用时优先使用 Pointer Lock。

import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'

/** 最近一次调用时间（防抖：两次调用间隔 < 80ms 直接忽略） */
let lastSetAt = 0

/**
 * 把系统光标移动到指定屏幕坐标。
 * @returns ok=false 且 error='not-supported' 表示当前平台不支持
 */
export function setCursorPosition(x: number, y: number): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'not-supported' })
  }
  const now = Date.now()
  if (now - lastSetAt < 80) {
    // 防抖：PowerShell 子进程启动成本高，高频调用直接合并
    return Promise.resolve({ ok: true })
  }
  lastSetAt = now
  return new Promise((resolve) => {
    const script = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class CursorWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
}
'
[CursorWin32]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
`
    exec(
      `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
      { timeout: 2000 },
      (err) => {
        if (err) {
          console.warn('[cursor] SetCursorPos 失败:', err.message)
          resolve({ ok: false, error: err.message })
        } else {
          resolve({ ok: true })
        }
      },
    )
  })
}

/** 注册光标重置 IPC（app.whenReady 后由 main.ts 调用） */
export function registerCursorIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CURSOR_SET, (_e, x: number, y: number) => {
    return setCursorPosition(Number(x) || 0, Number(y) || 0)
  })
}
