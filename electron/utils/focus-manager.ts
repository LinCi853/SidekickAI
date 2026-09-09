// electron/utils/focus-manager.ts — 窗口焦点恢复管理器
//
// 统一管理"隐藏/关闭窗口后恢复之前聚焦的外部应用"的逻辑。
// 供所有通过快捷键或托盘切换显隐的窗口使用（主窗口、进阶面板等）。
//
// 隐藏策略：minimize + skipTaskbar，彻底从屏幕/Alt+Tab/任务栏中消失，
// 比 win.hide()（SW_HIDE）更彻底——SW_HIDE 仍会被 EnumWindows 枚举到。
//
// 性能设计：
//   - show() 完全同步，不调用 PowerShell，立即显示窗口
//   - hide() 窗口操作同步，恢复外部焦点异步（fire-and-forget）
//   - 句柄捕获在 hide() 之后异步执行（此时焦点已自动落到外部窗口）
//   - macOS/Linux 暂不支持，预留接口
//
// 典型用法（以 Alt+Space 切换主窗口为例）：
//   focusManager.track(win)          // 窗口创建后调用一次
//   focusManager.show(win)           // 热键显示：同步，立即生效
//   focusManager.hide(win)           // 热键隐藏：同步隐藏 + 异步恢复外部焦点

import type { BrowserWindow } from 'electron'
import { exec } from 'child_process'
import { findWindowIdByWin } from '../window-factory/window-utils.js'
import { isTrackedFullscreen } from './fullscreen-tracker.js'

/** 窗口 → 追踪状态（外部句柄 + 隐藏前的窗口形态，供 show 时精确恢复） */
interface TrackedState {
  /** 之前聚焦的外部前台窗口句柄（hide 后异步捕获，供下次 show 时恢复） */
  prevHandle: number | null
  /** 隐藏前是否最大化（frameless 窗口 minimize+hide 往返后 Windows 可能丢失最大化状态） */
  wasMaximized: boolean
  /** 隐藏前是否全屏 */
  wasFullScreen: boolean
  /** 隐藏前 bounds（非最大化时用于校验宽度不被 Windows/minWidth 调整） */
  bounds: { x?: number; y?: number; width: number; height: number } | null
}

/** 窗口 → 追踪状态 */
const states = new Map<BrowserWindow, TrackedState>()

/**
 * 开始追踪窗口。
 * 在窗口创建后调用一次。窗口销毁时自动清理。
 */
export function track(win: BrowserWindow): void {
  if (states.has(win)) return
  states.set(win, { prevHandle: null, wasMaximized: false, wasFullScreen: false, bounds: null })
  win.on('closed', () => { states.delete(win) })
}

/** 停止追踪窗口（通常不需要手动调用，closed 事件自动清理） */
export function untrack(win: BrowserWindow): void {
  states.delete(win)
}

/**
 * 显示窗口：恢复 skipTaskbar + show + focus。
 * 完全同步，不调用 PowerShell，立即生效。
 */
export function show(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const st = states.get(win)
  win.setSkipTaskbar(false)
  if (win.isMinimized()) win.restore()
  win.show()
  if (st?.wasFullScreen) {
    // 全屏窗口：恢复全屏
    const wid = findWindowIdByWin(win)
    const isFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
    if (!isFs) win.setFullScreen(true)
  } else if (st?.wasMaximized) {
    // 最大化窗口：minimize + hide 往返后，frameless 窗口的原生最大化标记可能丢失，
    // 表现为恢复后变成普通尺寸（宽度莫名其妙变化）。此处重新最大化。
    if (!win.isMaximized()) win.maximize()
  } else if (st?.bounds) {
    // 普通窗口：Windows 在 restore 时可能按动态 minWidth 等强制调整尺寸，
    // 若宽度/高度与隐藏前不一致则恢复隐藏前尺寸。
    const b = win.getBounds()
    if (b.width !== st.bounds.width || b.height !== st.bounds.height) {
      try {
        win.setBounds({ ...st.bounds })
      } catch { /* ignore */ }
    }
  }
  win.focus()
}

/**
 * 隐藏窗口并恢复之前聚焦的外部应用。
 *
 * 隐藏策略：minimize + skipTaskbar，比 win.hide()（SW_HIDE）更彻底。
 * 窗口操作同步执行；焦点恢复和句柄捕获异步执行（不阻塞主进程）。
 *
 * 流程：
 *   1. 读取之前缓存的外部窗口句柄
 *   2. minimize + skipTaskbar + hide（同步，窗口立即消失）
 *   3. 异步恢复外部窗口焦点
 *   4. 异步捕获当前前台窗口句柄（此时焦点已落到外部窗口），缓存供下次使用
 */
export function hide(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const st = states.get(win) ?? { prevHandle: null, wasMaximized: false, wasFullScreen: false, bounds: null }
  // 记住隐藏前的窗口形态（minimize 之前读取，避免动画中间态）
  st.wasMaximized = win.isMaximized()
  const wid = findWindowIdByWin(win)
  st.wasFullScreen = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
  st.bounds = win.getBounds()
  states.set(win, st)
  // 同步隐藏：minimize + skipTaskbar + hide，窗口立即从所有界面消失
  win.minimize()
  win.setSkipTaskbar(true)
  win.hide()
  // 异步恢复外部窗口焦点（fire-and-forget，不阻塞）
  if (st.prevHandle) restoreAsync(st.prevHandle)
  // 异步捕获当前前台窗口句柄（此时焦点已自动落到外部窗口），缓存供下次 show 使用
  captureForegroundAsync().then((handle) => {
    const cur = states.get(win)
    if (cur) {
      cur.prevHandle = handle
      states.set(win, cur)
    }
  })
}

/**
 * 关闭（销毁）窗口并恢复之前聚焦的外部应用。
 * 适用于进阶面板等每次打开都重建的窗口。
 */
export function close(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const prev = states.get(win)?.prevHandle ?? null
  win.close()
  if (prev) restoreAsync(prev)
}

/**
 * 异步获取当前前台窗口的原生句柄（HWND on Windows）。
 * 不阻塞主进程。macOS/Linux 返回 null。
 */
function captureForegroundAsync(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -Command "Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); }\'; [Win32]::GetForegroundWindow().ToInt64()"',
      { encoding: 'utf-8', timeout: 3000 },
      (err, stdout) => {
        if (err) {
          console.warn('[focus-manager] 获取前台窗口句柄失败:', err.message)
          resolve(null)
          return
        }
        const handle = parseInt(stdout.trim(), 10)
        resolve(isNaN(handle) ? null : handle)
      },
    )
  })
}

/**
 * 异步恢复指定句柄的窗口为前台。
 * 使用 PowerShell + user32.dll SetForegroundWindow，不阻塞主进程。
 */
function restoreAsync(handle: number): void {
  if (process.platform !== 'win32') return
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
  [Win32]::ShowWindow($hwnd, 9)
}
[Win32]::SetForegroundWindow($hwnd)
`
  exec(
    `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
    { timeout: 5000 },
    (err) => {
      if (err) {
        console.warn('[focus-manager] 恢复前台窗口失败:', err.message)
      } else {
        console.log('[focus-manager] 恢复前台窗口成功:', handle)
      }
    },
  )
}
