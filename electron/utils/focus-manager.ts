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
  /**
   * 显隐代际：每次 show/hide 递增。
   * 迟到的异步操作（旧隐藏的外部焦点恢复、旧唤出的激活核验）凭代际失效，
   * 避免"快速 hide→show 后，迟到的 SetForegroundWindow 把焦点抢回外部窗口"。
   */
  generation: number
  /**
   * 在途外部焦点恢复的估计完成截止时间（fake-clock 敏感，仅用于安排守卫）；0 = 无在途恢复。
   * PowerShell 一旦派生便无法可靠中断（exec 经 cmd.exe 包装，kill 杀不掉子进程），
   * show 只能在其执行完成后重申前台焦点。
   */
  restoreInFlightUntil: number
}

/** 窗口 → 追踪状态 */
const states = new Map<BrowserWindow, TrackedState>()

/** 唤出后首次核验焦点是否落下的延迟 */
const ACTIVATION_CHECK_DELAY_MS = 150
/** 激活重试（moveTop + focus，仅一次）后的复核延迟 */
const ACTIVATION_RETRY_DELAY_MS = 300
/** 外部焦点恢复前的延迟：给"新唤出取消旧恢复"留出取消窗口 */
const RESTORE_DELAY_MS = 120
/**
 * 恢复进程（PowerShell 冷启动+执行）从派生到完成的估计上界。
 * 取消窗口只有 120ms，此后 PowerShell 已派生、无法中断：若期间用户唤出窗口，
 * 迟到的 SetForegroundWindow 会把焦点抢回外部窗口（表现为"收起后再打开不出现在前台"）。
 * show 侧据此安排晚期重申守卫。
 */
const RESTORE_EXEC_GRACE_MS = 3000
/** 晚期重申守卫在恢复估计完成之后再延后的余量 */
const RESTORE_GUARD_MARGIN_MS = 150

/**
 * 开始追踪窗口。
 * 在窗口创建后调用一次。窗口销毁时自动清理。
 */
export function track(win: BrowserWindow): void {
  if (states.has(win)) return
  states.set(win, { prevHandle: null, wasMaximized: false, wasFullScreen: false, bounds: null, generation: 0, restoreInFlightUntil: 0 })
  win.on('closed', () => { states.delete(win) })
}

/** 停止追踪窗口（通常不需要手动调用，closed 事件自动清理） */
export function untrack(win: BrowserWindow): void {
  states.delete(win)
}

/**
 * 显示窗口：恢复 skipTaskbar + show + focus。
 * 完全同步，不调用 PowerShell，立即生效。
 *
 * 唤出后异步核验焦点是否真正落下；未落下时做一次有界 moveTop+focus 重试
 * （不改动用户置顶偏好）。对可见未聚焦的窗口调用也是安全的：
 * 只补焦点，不回弹窗口形态。
 */
export function show(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const st = states.get(win)
  const generation = st ? ++st.generation : 0
  // 可见未聚焦时只补焦点，不做形态恢复（bounds 是上次 hide 时的快照，回弹会撤销用户的调整）
  const wasHidden = !win.isVisible() || win.isMinimized()
  win.setSkipTaskbar(false)
  if (win.isMinimized()) win.restore()
  win.show()
  if (wasHidden && st) {
    if (st.wasFullScreen) {
      // 全屏窗口：恢复全屏
      const wid = findWindowIdByWin(win)
      const isFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
      if (!isFs) win.setFullScreen(true)
    } else if (st.wasMaximized) {
      // 最大化窗口：minimize + hide 往返后，frameless 窗口的原生最大化标记可能丢失，
      // 表现为恢复后变成普通尺寸（宽度莫名其妙变化）。此处重新最大化。
      if (!win.isMaximized()) win.maximize()
    } else if (st.bounds) {
      // 普通窗口：Windows 在 restore 时可能按动态 minWidth 等强制调整尺寸，
      // 若宽度/高度与隐藏前不一致则恢复隐藏前尺寸。
      const b = win.getBounds()
      if (b.width !== st.bounds.width || b.height !== st.bounds.height) {
        try {
          win.setBounds({ ...st.bounds })
        } catch { /* ignore */ }
      }
    }
  }
  win.focus()
  scheduleActivationCheck(win)
  scheduleRestoreGuard(win, generation)
}

/**
 * 唤出后核验窗口是否真正取得前台焦点。
 * Windows 前台锁定会拒绝非前台进程的 SetForegroundWindow（典型：独占全屏游戏在前台），
 * 首次失败时做一次有界 moveTop + focus 重试；仍失败则记录警告（不永久置顶、不与
 * window-events 的置顶偏好回放竞争）。
 */
function scheduleActivationCheck(win: BrowserWindow): void {
  const generation = states.get(win)?.generation
  setTimeout(() => {
    if (win.isDestroyed()) return
    const cur = states.get(win)
    if (!cur || cur.generation !== generation) return
    if (win.isFocused()) return
    activateWithSteal(win)
    setTimeout(() => {
      if (win.isDestroyed()) return
      const later = states.get(win)
      if (!later || later.generation !== generation) return
      if (!win.isFocused()) {
        console.warn(
          '[focus-manager] 唤出后窗口未取得前台焦点（可能受前台锁定/全屏应用限制）',
        )
      }
    }, ACTIVATION_RETRY_DELAY_MS)
  }, ACTIVATION_CHECK_DELAY_MS)
}

/**
 * 带前台锁定绕过的激活：短暂 topmost 触发系统级激活，随后还原置顶状态。
 * Windows 前台锁定会拒绝后台进程的 SetForegroundWindow（fallback 热键、提权/全屏
 * 窗口在前台等场景），而置顶窗口 show 可正常取得前台——借此强行夺回焦点。
 * window-events 的 reapplyAlwaysOnTop 会在 show/focus 事件里按用户偏好还原置顶，
 * 与本函数"短暂 topmost → 还原"的语义一致，不会相互冲突。
 */
function activateWithSteal(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  const wasTopmost = win.isAlwaysOnTop()
  try { win.setAlwaysOnTop(true) } catch { /* ignore */ }
  win.show()
  try { win.setAlwaysOnTop(wasTopmost) } catch { /* ignore */ }
  win.moveTop()
  win.focus()
}

/**
 * 晚期重申守卫：hide 派生的外部焦点恢复进程（PowerShell）无法在派生后取消，
 * 若用户在其执行完成前唤出窗口，迟到的 SetForegroundWindow 会把焦点抢回外部窗口。
 * 守卫在恢复估计完成之后检查一次，窗口未取得焦点则强行重申。
 */
function scheduleRestoreGuard(win: BrowserWindow, generation: number): void {
  const st = states.get(win)
  if (!st || generation === 0) return
  const delay = st.restoreInFlightUntil - Date.now() + RESTORE_GUARD_MARGIN_MS
  if (delay <= 0) return
  setTimeout(() => {
    if (win.isDestroyed()) return
    const cur = states.get(win)
    if (!cur || cur.generation !== generation) return
    if (win.isFocused()) return
    console.log('[focus-manager] 外部焦点恢复期间唤出，重申主窗口前台焦点')
    activateWithSteal(win)
    setTimeout(() => {
      if (win.isDestroyed()) return
      const later = states.get(win)
      if (!later || later.generation !== generation) return
      if (!win.isFocused()) {
        console.warn(
          '[focus-manager] 重申前台后窗口仍未取得焦点（可能受前台锁定/提权窗口限制）',
        )
      }
    }, ACTIVATION_RETRY_DELAY_MS)
  }, delay)
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
  const st = states.get(win) ?? { prevHandle: null, wasMaximized: false, wasFullScreen: false, bounds: null, generation: 0, restoreInFlightUntil: 0 }
  // 记住隐藏前的窗口形态（minimize 之前读取，避免动画中间态）
  st.wasMaximized = win.isMaximized()
  const wid = findWindowIdByWin(win)
  st.wasFullScreen = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
  st.bounds = win.getBounds()
  // 递增代际：取消未完成的旧激活核验/旧恢复；在途恢复计时随之失效
  st.generation++
  st.restoreInFlightUntil = 0
  const generation = st.generation
  states.set(win, st)
  // 同步隐藏：minimize + skipTaskbar + hide，窗口立即从所有界面消失
  win.minimize()
  win.setSkipTaskbar(true)
  win.hide()
  // 异步恢复外部窗口焦点（fire-and-forget，不阻塞主进程）；新唤出会按代际取消，
  // 已派生的恢复进程无法中断，由 show 侧的晚期重申守卫兜底
  if (st.prevHandle) restoreAsync(st.prevHandle, () => {
    const cur = states.get(win)
    return !cur || cur.generation !== generation
  }, () => {
    const cur = states.get(win)
    if (cur && cur.generation === generation) {
      cur.restoreInFlightUntil = Date.now() + RESTORE_EXEC_GRACE_MS
    }
  })
  // 异步捕获当前前台窗口句柄（此时焦点已自动落到外部窗口），缓存供下次 show 使用
  captureForegroundAsync().then((handle) => {
    const cur = states.get(win)
    // 代际已前进（期间发生了新的 show/hide）则本次捕获作废，避免缓存到自己的句柄
    if (cur && cur.generation === generation) {
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
  if (prev) restoreAsync(prev, () => !states.has(win))
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
 * 先延迟 RESTORE_DELAY_MS 再执行，期间 isCancelled() 为 true（新唤出/关闭）则放弃，
 * 避免"快速 hide→show 后，迟到的 SetForegroundWindow 把焦点抢回外部窗口"。
 * onSpawned 在 PowerShell 实际派生后回调（此时已无法取消），供 show 侧安排晚期重申守卫。
 */
function restoreAsync(handle: number, isCancelled: () => boolean = () => false, onSpawned?: () => void): void {
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
  setTimeout(() => {
    if (isCancelled()) {
      console.log('[focus-manager] 旧的外部焦点恢复已被新唤出取消:', handle)
      return
    }
    onSpawned?.()
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
  }, RESTORE_DELAY_MS)
}
