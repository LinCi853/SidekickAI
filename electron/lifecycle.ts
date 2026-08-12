// electron/lifecycle.ts — 应用生命周期（启动健康检查 + 退出清理）
//
// 从 main.ts 抽离：
//   1. runUiohookHealthCheck：启动后延迟检测 uiohook 健康度，失败时通知用户
//   2. cleanupOnQuit：app.on('before-quit') 的清理逻辑
//      - 标记 isQuitting（主窗口 close 事件不再拦截）
//      - 注销热键 + 清理 STT 引擎 + 关闭活跃 AI 流
//      - 使用统计：记录退出时间（logAppEnd）
//      - 关闭 chat 数据库
//      - 销毁托盘 / 预览窗 / 历史窗 / 提示词库窗 / 进阶面板窗 / 引导窗 / AI 应用编辑窗
//      - 清理挂起的预览窗 + 剪贴板恢复定时器
//      - 兜底强制关闭所有窗口
//
// hotkeyManager 与 sttEngine 仍为 main.ts 全局实例，通过参数注入。

import { app, BrowserWindow } from 'electron'
import { cleanupActiveStreams } from './ai/handler.js'
import {
  getAppSettings,
} from './store/app-settings-store.js'
import {
  getChatStore,
  closeChatStore,
} from './store/chat-store.js'
import { windowState } from './window-state.js'
import { IPC_CHANNELS } from './shared/types.js'
import type { HotkeyManager } from './hotkey/manager.js'
import type { SttEngine } from './stt/engine.js'
import { showNotification } from './notify.js'
import { destroyTray } from './window/tray.js'
import { clearPreviewHideTimer } from './voice/preview-window.js'
import { clearClipboardRestoreTimer } from './voice/clipboard-paste.js'

/**
 * 启动后延迟检测 uiohook 健康度。
 * uiohook 是低层键盘钩子，可能因权限不足/安全软件拦截/驱动冲突而启动失败。
 * 启动后 2 秒检测一次状态，失败时通过系统通知 + 渲染层双通道告知用户。
 *
 * 在 app.whenReady 后由 main.ts 调用。
 */
export function runUiohookHealthCheck(hotkeyManager: HotkeyManager): void {
  setTimeout(() => {
    const status = hotkeyManager.getStatus()
    console.log('[main] 启动后状态检查:', JSON.stringify(status))
    if (!status.uiohookStarted) {
      const title = '语音热键未就绪'
      let body =
        '后台键盘监听（uiohook）启动失败，Alt+V 等语音热键将无法使用。'
      if (process.platform === 'darwin') {
        body +=
          '\nmacOS 需要授予「辅助功能」权限：系统设置 > 隐私与安全性 > 辅助功能，添加本应用。'
      } else {
        body +=
          '可能原因：被安全软件拦截、权限不足、驱动冲突。\n' +
          '请检查后重启应用，或在设置中查看详情。'
      }
      console.error('[main] uiohook 未启动：', body)
      showNotification(title, body)
      // 同步通知渲染层
      const mainWin = windowState.mainWindow
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send(IPC_CHANNELS.HOTKEY_STATUS, status)
      }
    } else {
      console.log('[main] uiohook 启动成功，热键就绪')
    }
  }, 2000)
}

/** 由 main.ts 注入的依赖（hotkeyManager/sttEngine 仍为 main.ts 全局实例） */
export interface LifecycleDeps {
  hotkeyManager: HotkeyManager
  sttEngine: SttEngine
}

/**
 * 应用退出前的清理逻辑（main.ts 在 app.on('before-quit') 中调用）。
 *
 * 顺序与原 main.ts 完全一致，仅做代码搬迁：
 *   1. 标记 isQuitting
 *   2. 注销热键 / 清理 STT / 关闭活跃流
 *   3. 记录退出时间 + 关闭 chat 数据库
 *   4. 销毁各类窗口与托盘
 *   5. 清理挂起定时器
 *   6. 兜底强制关闭所有窗口
 */
export function cleanupOnQuit(deps: LifecycleDeps): void {
  const { hotkeyManager, sttEngine } = deps
  // 标记应用正在退出，主窗口 close 事件不再拦截（避免 minimize 模式阻止退出）
  ;(app as unknown as { isQuitting: boolean }).isQuitting = true
  hotkeyManager?.unregisterAll()
  sttEngine?.cleanup()
  cleanupActiveStreams()
  // 使用统计：记录退出时间（在 closeChatStore 之前调用，确保 db 仍可用）
  try {
    if (getAppSettings().usageTrackingEnabled) {
      getChatStore().logAppEnd()
    }
  } catch (e) {
    console.warn('[main] logAppEnd 失败:', e)
  }
  closeChatStore()
  // 退出前恢复所有冻结的 webview（避免残留 debugger 阻止退出）
  // 异步执行，before-quit 不等待；detachTab 内部对已销毁 webview 容错
  import('./freeze/freeze-manager.js')
    .then(({ detachAll }) => { void detachAll() })
    .catch(() => { /* ignore */ })
  // 销毁托盘
  destroyTray()
  // 销毁预览窗（避免进程残留）
  if (windowState.previewWindow && !windowState.previewWindow.isDestroyed()) {
    windowState.previewWindow.destroy()
    windowState.previewWindow = null
  }
  // 清理挂起的剪贴板恢复定时器（避免退出后仍尝试写剪贴板）
  clearClipboardRestoreTimer()
  // 销毁历史搜索窗（避免进程残留）
  if (windowState.historyWindow && !windowState.historyWindow.isDestroyed()) {
    windowState.historyWindow.destroy()
    windowState.historyWindow = null
  }
  // 销毁提示词库窗（避免进程残留）
  if (windowState.promptWindow && !windowState.promptWindow.isDestroyed()) {
    windowState.promptWindow.destroy()
    windowState.promptWindow = null
  }
  // 销毁进阶面板窗（避免进程残留）
  if (windowState.advancedPanelWindow && !windowState.advancedPanelWindow.isDestroyed()) {
    windowState.advancedPanelWindow.destroy()
    windowState.advancedPanelWindow = null
  }
  // 销毁引导窗（避免进程残留）
  if (windowState.onboardingWindow && !windowState.onboardingWindow.isDestroyed()) {
    windowState.onboardingWindow.destroy()
    windowState.onboardingWindow = null
  }
  // 销毁所有 AI 应用编辑窗（避免进程残留）
  if (windowState.aiAppEditorWindows.size > 0) {
    for (const [, w] of windowState.aiAppEditorWindows) {
      if (!w.isDestroyed()) w.destroy()
    }
    windowState.aiAppEditorWindows.clear()
  }
  clearPreviewHideTimer()
  // 兜底：强制关闭所有尚未关闭的窗口，确保进程退出
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close()
  }
}
