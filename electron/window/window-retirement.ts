// electron/window/window-retirement.ts — 后台窗口自动退役
//
// 非主窗口在无焦点且无受保护状态时，闲置超时后自动关闭，
// 释放整个窗口的渲染进程与 guest。主窗口不在此列（走托盘 + 标签休眠）。
import { app, BrowserWindow, powerMonitor, webContents } from 'electron'

export interface WindowRetirementOptions {
  /** 闲置秒数，到点关闭 */
  seconds: number
  /** 返回 false 则永不退役（置顶、模态、导入中等） */
  eligible?: (win: BrowserWindow) => boolean
  /** 关闭前自定义清理；返回 false 则放弃本次关闭 */
  prepareClose?: (win: BrowserWindow) => Promise<boolean> | boolean
}

const tracked = new Map<BrowserWindow, { options: WindowRetirementOptions; deadline: number | null; paused: boolean }>()
let timer: ReturnType<typeof setInterval> | null = null
let suspended = false
/** 由后台退役/后台释放发起关闭的窗口：closed 回调据此不抢前台 */
const backgroundClosing = new WeakSet<BrowserWindow>()

/** 标记窗口即将被后台机制关闭 */
export function markBackgroundClose(win: BrowserWindow): void {
  backgroundClosing.add(win)
}

/** 窗口是否由后台退役/后台释放关闭（非用户主动关闭） */
export function isBackgroundClose(win: BrowserWindow): boolean {
  return backgroundClosing.has(win)
}

/** 窗口自身或其承载的 webview 是否正在出声：播放中不得关闭 */
export function isWindowAudible(win: BrowserWindow): boolean {
  try {
    const host = win.webContents
    if (!host || host.isDestroyed()) return false
    if (host.isCurrentlyAudible()) return true
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.getType() !== 'webview') continue
      if (wc.hostWebContents === host && wc.isCurrentlyAudible()) return true
    }
  } catch { /* 窗口销毁中，按不出声处理 */ }
  return false
}

function isEligible(win: BrowserWindow, options: WindowRetirementOptions): boolean {
  if (win.isDestroyed() || (app as { isQuitting?: boolean }).isQuitting) return false
  if (suspended) return false
  // 置顶窗常驻不退役
  if (win.isAlwaysOnTop()) return false
  // 焦点窗（或其子窗）不退役：用户正在用。不聚焦即计入退役候选，不区分是否仍可见
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && (focused === win || focused.getParentWindow?.() === win)) return false
  // 正在播放的窗口不退役
  if (isWindowAudible(win)) return false
  return options.eligible?.(win) ?? true
}

function tick(): void {
  const now = Date.now()
  for (const [win, entry] of tracked) {
    if (win.isDestroyed()) {
      tracked.delete(win)
      continue
    }
    if (!isEligible(win, entry.options)) {
      entry.deadline = null
      continue
    }
    if (entry.deadline == null) {
      entry.deadline = now + entry.options.seconds * 1000
      continue
    }
    if (now < entry.deadline) continue
    entry.deadline = null
    void (async () => {
      try {
        if (entry.options.prepareClose && !(await entry.options.prepareClose(win))) return
        if (win.isDestroyed()) return
        markBackgroundClose(win)
        win.close()
      } catch {
        /* 关闭失败下次再试 */
      }
    })()
  }
  if (!tracked.size && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 登记需要后台退役的用户窗口（主窗口请勿登记） */
export function registerWindowRetirement(win: BrowserWindow, options: WindowRetirementOptions): void {
  if (tracked.has(win)) return
  tracked.set(win, { options, deadline: null, paused: false })
  const refresh = () => {
    // 窗口状态仍在变化说明上次后台关闭被页面拦下，撤销标记
    backgroundClosing.delete(win)
    const entry = tracked.get(win)
    if (entry) entry.deadline = isEligible(win, entry.options) ? Date.now() + entry.options.seconds * 1000 : null
  }
  win.on('hide', refresh)
  win.on('minimize', refresh)
  win.on('show', refresh)
  win.on('restore', refresh)
  win.on('blur', refresh)
  win.on('focus', refresh)
  win.once('closed', () => {
    tracked.delete(win)
    if (!tracked.size && timer) {
      clearInterval(timer)
      timer = null
    }
  })
  timer ??= setInterval(tick, 1000)
  timer.unref?.()
}

/** 测试辅助 */
export function resetWindowRetirementForTest(): void {
  tracked.clear()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  suspended = false
}

let powerHooked = false
function hookPower(): void {
  if (powerHooked) return
  powerHooked = true
  powerMonitor.on('suspend', () => { suspended = true })
  powerMonitor.on('resume', () => { suspended = false })
}

hookPower()
