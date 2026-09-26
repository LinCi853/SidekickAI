// Application health checks and shutdown coordination.

import { app } from 'electron'
import { isImportingData } from './store/import-guard.js'
import { cleanupActiveStreams } from './ai/handler.js'
import { getAppSettings } from './store/app-settings-store.js'
import { getChatStore } from './store/chat-store.js'
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
  /** 语音模块未启用时为 null（sttEngine?.cleanup() 天然容忍） */
  sttEngine: SttEngine | null
}

/** Release background work while Electron closes windows through beforeunload. */
export function cleanupOnQuit(deps: LifecycleDeps): void {
  const { hotkeyManager, sttEngine } = deps
  // 标记应用正在退出，主窗口 close 事件不再拦截（避免 minimize 模式阻止退出）
  ;(app as unknown as { isQuitting: boolean }).isQuitting = true
  for (const timer of windowState.boundsSaveTimers.values()) clearTimeout(timer)
  windowState.boundsSaveTimers.clear()
  hotkeyManager?.unregisterAll()
  sttEngine?.cleanup()
  cleanupActiveStreams()
  // 使用统计：记录退出时间（在 closeChatStore 之前调用，确保 db 仍可用）
  try {
    if (!isImportingData && getAppSettings().usageTrackingEnabled) {
      getChatStore().logAppEnd()
    }
  } catch (e) {
    console.warn('[main] logAppEnd 失败:', e)
  }
  // 退出前恢复所有冻结的 webview（避免残留 debugger 阻止退出）
  // 异步执行，before-quit 不等待；detachTab 内部对已销毁 webview 容错
  import('./freeze/freeze-manager.js')
    .then(({ detachAll }) => { void detachAll() })
    .catch(() => { /* ignore */ })
  // 销毁托盘
  destroyTray()
  clearClipboardRestoreTimer()
  clearPreviewHideTimer()
}
