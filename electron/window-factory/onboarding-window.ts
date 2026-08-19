// electron/window-factory/onboarding-window.ts — 引导（Onboarding）独立窗口创建
//
// 首次启动时弹出，介绍功能、窗口命名、快捷键，并提供快速设置。
// 关闭（调 ONBOARDING_COMPLETE）后主窗口才 show。
// 单例：windowState.onboardingWindow。已存在则聚焦。

import { BrowserWindow, screen } from 'electron'
import { windowState } from '../window-state.js'
import {
  WINDOW_BACKGROUND_COLOR,
  ONBOARDING_WINDOW_ID,
  getPreloadPath,
  createDefaultWebPreferences,
  loadRenderer,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'

/** 引导窗口生命周期回调（由 main.ts 注册，用于暂停/恢复全局热键） */
let lifecycleCb: { onShow?: () => void; onClose?: () => void } = {}

/** 注册引导窗口生命周期回调 */
export function setOnboardingLifecycleCallbacks(cb: { onShow?: () => void; onClose?: () => void }): void {
  lifecycleCb = cb
}

/**
 * 创建/显示引导独立窗口（单例）。
 * 首次启动或用户从菜单「使用指南」重新打开时调用。
 */
export function showOnboardingWindow(): void {
  if (windowState.onboardingWindow && !windowState.onboardingWindow.isDestroyed()) {
    if (windowState.onboardingWindow.isMinimized()) windowState.onboardingWindow.restore()
    if (!windowState.onboardingWindow.isVisible()) windowState.onboardingWindow.show()
    windowState.onboardingWindow.focus()
    lifecycleCb.onShow?.()
    return
  }
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(880, workArea.width - 80)
  const height = Math.min(680, workArea.height - 80)
  const x = workArea.x + Math.round((workArea.width - width) / 2)
  const y = workArea.y + Math.round((workArea.height - height) / 2)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: 560,
    minHeight: 480,
    show: false,
    frame: false,
    resizable: true,
    // 引导窗口无需最大化，禁用系统级最大化（用户也不需要从窗口标题栏最大化）
    maximizable: false,
    // 禁用全屏，防止触发 Chromium 原生全屏（引导窗口不监听全屏热键）
    fullscreenable: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: '工百窗 - 使用指南',
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: false,
    }),
  }))
  windowState.onboardingWindow = win
  loadRenderer(win, ONBOARDING_WINDOW_ID, 'onboarding')

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    lifecycleCb.onShow?.()
  })

  win.on('closed', () => {
    windowState.onboardingWindow = null
    lifecycleCb.onClose?.()
  })
}
