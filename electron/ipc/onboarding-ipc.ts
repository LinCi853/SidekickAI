// electron/ipc/onboarding-ipc.ts — 引导（Onboarding）相关 IPC 注册
//
// 从 main.ts 抽离的 inline IPC handler：
//   - ONBOARDING_SHOW：从菜单「使用指南」重新打开引导窗
//   - ONBOARDING_IS_COMPLETED：引导窗渲染层查询当前状态（决定按钮文案）
//   - ONBOARDING_COMPLETE：用户点「开始使用」→ 合并保存快速设置 + 标记完成 +
//     关闭引导窗 + 显示主窗口
//
// 在 app.whenReady 后由 main.ts 调用 registerOnboardingIpc() 完成注册。

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { windowState } from '../window-state.js'
import {
  getAppSettings,
  updateAppSettings,
} from '../store/app-settings-store.js'
import { showOnboardingWindow } from '../window-factory.js'

/** 注册引导相关 IPC handler */
export function registerOnboardingIpc(): void {
  // ===== 引导 IPC =====
  // ONBOARDING_SHOW：从菜单「使用指南」重新打开引导窗
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_SHOW, () => {
    showOnboardingWindow()
  })
  // ONBOARDING_IS_COMPLETED：引导窗渲染层查询当前状态（决定按钮文案）
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_IS_COMPLETED, () => {
    try {
      return getAppSettings().onboardingCompleted
    } catch {
      return false
    }
  })
  // ONBOARDING_COMPLETE：用户点「开始使用」→ 合并保存快速设置 + 标记完成 + 关闭引导窗 + 显示主窗口
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_COMPLETE, (_e, patch?: Record<string, unknown>) => {
    try {
      updateAppSettings({ onboardingCompleted: true, ...(patch as Partial<ReturnType<typeof getAppSettings>> | undefined) })
    } catch (err) {
      console.error('[main] 保存 onboarding 设置失败:', err)
    }
    // 关闭引导窗
    if (windowState.onboardingWindow && !windowState.onboardingWindow.isDestroyed()) {
      windowState.onboardingWindow.close()
    }
    // 显示主窗口（首次启动时主窗口未 show）
    const mainWin = windowState.mainWindow
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
      mainWin.show()
      mainWin.focus()
      mainWin.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
    }
  })
}
