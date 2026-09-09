// electron/utils/fullscreen-tracker.ts — 全屏状态追踪器
//
// win.isFullScreen() 在 Windows frameless 窗口中不可靠（enter-full-screen
// 事件已触发但 isFullScreen() 仍返回 false）。本模块通过原生事件维护
// 一份可信的全屏状态映射，供所有主进程 handler 使用。

import type { BrowserWindow } from 'electron'

/** windowId → isFullscreen */
const state = new Map<string, boolean>()

export function isTrackedFullscreen(windowId: string): boolean {
  return state.get(windowId) ?? false
}

/** 在创建浏览器窗口时调用：注册原生事件同步状态 */
export function trackFullscreen(win: BrowserWindow, windowId: string): void {
  // 初始化：用当前值（可能不准确，但作为起点）
  state.set(windowId, false)

  win.on('enter-full-screen', () => {
    state.set(windowId, true)
    console.log('[fullscreen-tracker] enter-full-screen →', windowId, 'now=true')
  })

  win.on('leave-full-screen', () => {
    state.set(windowId, false)
    console.log('[fullscreen-tracker] leave-full-screen →', windowId, 'now=false')
  })

  // 窗口销毁时清理
  win.on('closed', () => {
    state.delete(windowId)
  })
}
