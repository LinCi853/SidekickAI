// electron/diagnostics/background-release.ts — 纯后台应用内释放
//
// 应用长时间整体无焦点后：关闭已隐藏/最小化的次窗口，释放其渲染进程。
// 只负责次窗口生命周期；主窗口及其已加载网页保持运行态。
import { BrowserWindow } from 'electron'
import { windowState } from '../platform/window/window-state.js'
import { backgroundReleaseDelayMs } from '../shared/background-policy.js'
import { isWindowAudible, markBackgroundClose } from '../platform/window/window-retirement.js'
import { isLowMemoryMode } from '../store/low-memory-mode.js'

export interface BackgroundReleaseResult {
  windowsClosed: number
  guestsClosed: number
}

/**
 * 关闭除主窗口、语音预览外、当前无焦点的次窗口。
 * 不聚焦即视为可收（不区分是否仍可见）；正在出声的窗口保留；
 * 走 close() 而非 destroy()，页面的离开确认与关闭时的状态保存照常执行。
 */
export function closeSecondaryWindows(): number {
  let closed = 0
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (windowState.mainWindow === win) continue
    if (windowState.previewWindow === win) continue
    if (isWindowAudible(win)) continue
    try {
      markBackgroundClose(win)
      win.close()
      closed += 1
    } catch { /* 已在销毁 */ }
  }
  return closed
}

let releaseTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 纯后台释放（主进程侧）：只收次窗口。
 * 已加载 guest 保持挂载，工作集由驻留监控器安全回收。
 */
export function releaseBackgroundMemory(): BackgroundReleaseResult {
  const windowsClosed = closeSecondaryWindows()
  console.log(
    `[background-release] 次窗口释放: secondary=${windowsClosed} (主窗及其网页保持运行态)`,
  )
  return { windowsClosed, guestsClosed: 0 }
}

/**
 * 进入后台后延迟评估次窗口释放。
 * 「后台」= 应用内没有焦点窗口（含被其它程序挡住、未最小化的情形）。
 * 延迟期内若重新获得焦点则取消。未显式传入时按低内存模式分档（15 / 30 分钟）。
 */
export function scheduleBackgroundRelease(delayMs?: number): void {
  cancelBackgroundRelease()
  const effectiveDelayMs = delayMs ?? backgroundReleaseDelayMs(isLowMemoryMode())
  console.log(`[background-release] 已计划 ${Math.round(effectiveDelayMs / 60_000)} 分钟后评估后台释放`)
  releaseTimer = setTimeout(() => {
    releaseTimer = null
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) return
    console.log('[background-release] 检测到应用无焦点，开始释放')
    releaseBackgroundMemory()
  }, effectiveDelayMs)
}

export function cancelBackgroundRelease(): void {
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
    console.log('[background-release] 重新获得焦点，取消后台释放')
  }
}
