// electron/utils/cloud-pc.ts — 云电脑模式（主进程状态与系统级保障）
//
// 云电脑模式：为云电脑/云游戏类网页提供干净的输入直通环境——
//   - 进入时挂起全部应用级全局热键（复用 HotkeyManager.pauseAllShortcuts，
//     globalShortcut 注销 + uiohook 匹配跳过双保险），Alt+Space/Alt+Q 等
//     不会再被应用拦截，按键可直达远端。
//   - helpers.ts 的 before-input-event 在云电脑模式下不再拦截任何页面级
//     快捷键（F5/F11/Ctrl+W 等全部放行给页面）。
//   - 冗余退出手段（防止「退不出来」）：
//       1) 渲染层悬浮条按钮（鼠标移到顶部）
//       2) Ctrl+Alt+Shift+F12（主进程兜底，渲染层无响应也能退）
//       3) 三连击 Esc（1 秒内连按三次，前两次放行给远端）
//       4) 直接关闭浏览器窗口
//   退出时恢复全部全局热键 + 退出全屏。

import type { BrowserWindow } from 'electron'
import { exec } from 'child_process'
import type { HotkeyManager } from '../hotkey/manager.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { findWindowIdByWin } from '../window-factory/window-utils.js'
import { isTrackedFullscreen } from './fullscreen-tracker.js'

/** 处于云电脑模式的浏览器窗口（parentWebContents.id） */
const cloudPcParentIds = new Set<number>()
/** parentWebContents.id → 浏览器窗口（按键路由/回焦/恢复使用） */
const cloudPcWindows = new Map<number, BrowserWindow>()

let hotkeyManager: HotkeyManager | null = null

// ===== Win 键状态跟踪（单独按下 Win 键时关闭系统开始菜单，组合键场景不干预） =====
let metaDownAt = 0
let metaHasCombo = false
// ===== Esc 三连击跟踪（uiohook 全局钩子，独立于 guest before-input-event） =====
let escPressTimes: number[] = []

/** main.ts 注入 HotkeyManager（避免循环依赖） */
export function setCloudPcHotkeyManager(mgr: HotkeyManager): void {
  hotkeyManager = mgr
}

/** 当前窗口是否处于云电脑模式 */
export function isCloudPc(parentWebContentsId: number): boolean {
  return cloudPcParentIds.has(parentWebContentsId)
}

/** 进入云电脑模式：挂起全局热键 + 记录状态 + 启动系统级按键路由 */
export function enterCloudPc(parentWebContentsId: number, win: BrowserWindow): void {
  cloudPcParentIds.add(parentWebContentsId)
  cloudPcWindows.set(parentWebContentsId, win)
  hotkeyManager?.pauseAllShortcuts()
  hotkeyManager?.setCloudPcKeyListener((e) => handleCloudPcKey(parentWebContentsId, e))
  console.log('[cloud-pc] 进入云电脑模式, parentId:', parentWebContentsId)
}

/** 退出云电脑模式：恢复全局热键 + 清理状态（全部窗口退出后才恢复热键） */
export function exitCloudPc(parentWebContentsId: number): void {
  if (!cloudPcParentIds.has(parentWebContentsId)) return
  cloudPcParentIds.delete(parentWebContentsId)
  cloudPcWindows.delete(parentWebContentsId)
  if (cloudPcParentIds.size === 0) {
    hotkeyManager?.resumeAllShortcuts()
    hotkeyManager?.setCloudPcKeyListener(null)
  }
  console.log('[cloud-pc] 退出云电脑模式, parentId:', parentWebContentsId)
}

/**
 * 主进程兜底退出（before-input-event 的退出组合触发，不依赖渲染层响应）：
 * 恢复热键 + 退出全屏 + 通知渲染层同步状态。
 */
export function forceExitCloudPc(win: BrowserWindow, parentWebContentsId: number): void {
  exitCloudPc(parentWebContentsId)
  try {
    const wid = findWindowIdByWin(win)
    const wasFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen()
    if (wasFs) {
      win.setFullScreen(false)
    }
  } catch { /* ignore */ }
  try {
    win.webContents.send(IPC_CHANNELS.BROWSER_CLOUD_PC_CHANGED, false)
  } catch { /* ignore */ }
  console.log('[cloud-pc] 主进程兜底退出完成')
}
/**
 * 云电脑模式系统级按键处理：
 * - 转发给渲染层（合成注入到 guest，路由到云电脑）
 * - 抵消系统副作用：Alt+Tab 后自动回焦、Win+D 后恢复窗口、
 *   单独按下 Win 键弹起后关闭系统开始菜单
 */
function handleCloudPcKey(
  parentWebContentsId: number,
  e: { key: string; down: boolean; alt: boolean; win: boolean },
): void {
  const win = cloudPcWindows.get(parentWebContentsId)
  if (!win || win.isDestroyed()) return

  // 转发到渲染层（渲染层负责合成注入到 guest 页面）
  try {
    win.webContents.send(IPC_CHANNELS.BROWSER_CLOUD_PC_KEYS, e)
  } catch { /* ignore */ }

  if (e.key === 'escape') {
    // 三连击 Esc（1 秒内连续三次）：uiohook 全局捕获，前两次放行给远端，第三次兜底退出
    if (e.down) {
      const now = Date.now()
      escPressTimes.push(now)
      if (escPressTimes.length > 3) escPressTimes.shift()
      if (escPressTimes.length === 3 && now - escPressTimes[0] < 1000) {
        console.log('[cloud-pc] uiohook 三连击 Esc → 主进程兜底退出')
        escPressTimes = []
        forceExitCloudPc(win, parentWebContentsId)
      } else if (now - (escPressTimes[escPressTimes.length - 2] ?? 0) > 1000) {
        escPressTimes = [now]
      }
    }
    return
  }

  // Win 键状态跟踪（区分单独按 Win 与 Win+组合键）
  if (e.key === 'meta') {
    if (e.down) {
      metaDownAt = Date.now()
      metaHasCombo = false
    } else {
      // 单独按下 Win 键（无组合）→ 系统开始菜单已弹出，弹起后模拟一次 Win 关闭它
      const held = Date.now() - metaDownAt
      if (!metaHasCombo && held < 1500) {
        closeStartMenu()
      }
      metaDownAt = 0
    }
    return
  }

  // Win 按下期间出现其它键 → 组合键（Win+R 等），不再关闭开始菜单
  if (metaDownAt > 0 && e.down && metaDownAt > 0) {
    metaHasCombo = true
  }

  if (e.key === 'tab' && e.down) {
    // Alt+Tab / Win+Tab：系统会切换窗口 → 立即把云电脑窗口拉回前台
    // （按键本身已转发远端，远端执行应用切换，本地窗口保持前台）
    setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
      } catch { /* ignore */ }
    }, 120)
    return
  }

  if (e.key === 'd' && e.down) {
    // Win+D：系统显示桌面会最小化窗口 → 稍后恢复全屏窗口
    setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
      } catch { /* ignore */ }
    }, 350)
    return
  }

  // Alt+F4：系统会关闭窗口 → 窗口 close 保护在 browser-window.ts 处理
  // （按键已转发远端，远端应用执行关闭）
}

/** 模拟一次 Win 键按下+弹起（关闭被意外打开的系统开始菜单） */
function closeStartMenu(): void {
  if (process.platform !== 'win32') return
  const script = 'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }\'; [K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)'
  exec(
    `powershell -NoProfile -Command "${script}"`,
    { timeout: 2000 },
    (err) => {
      if (err) console.warn('[cloud-pc] 关闭开始菜单失败:', err.message)
    },
  )
}
