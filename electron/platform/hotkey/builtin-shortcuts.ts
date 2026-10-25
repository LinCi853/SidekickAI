// electron/platform/hotkey/builtin-shortcuts.ts — 内置热键回调（声明式注册表）
//
// 从 ipc/hotkey-ipc.ts 外置的内置热键行为：
//   - toggleMainWindow：切换主窗口显隐；连续 N 次触发时恢复默认窗口位置（防误触）
//   - toggleDetachedWindows：切换进阶面板显隐，无可用 tab 模块时由调用方守卫
//
// 依赖以端口形式注入，回调由 IPC 适配层按动作名组合，避免 IPC 层持有窗口与模块状态。

import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels.js'
import { getAppSettings } from '../../store/app-settings-repository.js'
import * as focusManager from '../../utils/focus-manager.js'
import { resetMainWindowToDefault } from '../window/main-window.js'
import type { HotkeyAction } from './types.js'

export interface BuiltinShortcutPorts {
  /** 实时读取主窗口（关闭/重建后仍指向当前实例） */
  getMainWindow: () => BrowserWindow | null
  /** 进阶面板是否可用（内置或插件声明了 advancedPanelTab 的已启用模块） */
  isAdvancedPanelAvailable: () => boolean
  /** 进阶面板显隐切换（Alt+Q，单例） */
  toggleAdvancedPanelWindow: () => void
}

type BuiltinShortcutCallbacks = Pick<
  Record<HotkeyAction, () => void>,
  'toggleMainWindow' | 'toggleDetachedWindows'
>

export function createBuiltinShortcuts(ports: BuiltinShortcutPorts): BuiltinShortcutCallbacks {
  // 连续 Alt+Space 触发计数（防误触恢复默认窗口位置），随回调实例保存在闭包内
  let recentToggles: number[] = []

  return {
    toggleMainWindow: () => {
      const now = Date.now()
      // 从 AppSettings 动态读取阈值，时间窗口随阈值线性放大
      const { altSpaceResetThreshold } = getAppSettings()
      const windowMs = Math.max(1500, altSpaceResetThreshold * 500)
      // 清理超过时间窗口的旧记录
      recentToggles = recentToggles.filter((t) => now - t < windowMs)
      recentToggles.push(now)

      // 连续达到阈值次 Alt+Space：恢复默认窗口位置和大小（防误触）
      if (recentToggles.length >= altSpaceResetThreshold) {
        recentToggles = []
        void resetMainWindowToDefault()
        return
      }

      // 正常切换显隐
      const mainWindow = ports.getMainWindow()
      if (!mainWindow) return
      if (!mainWindow.isVisible() || mainWindow.isMinimized()) {
        // 显示：采集唤出前前台窗口 → show + focus，随后通知渲染层
        void Promise.resolve(focusManager.show(mainWindow)).then(() => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
          }
        })
      } else if (!mainWindow.isFocused()) {
        // 可见但未聚焦：统一经焦点服务补焦点（含前台核验与一次有界重试），
        // 与隐藏/最小化唤出保持同一激活语义
        void Promise.resolve(focusManager.show(mainWindow)).then(() => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.WINDOW_SHOWN)
          }
        })
      } else {
        // 隐藏：hide + 异步把前台交还给唤出前的窗口（不阻塞主进程）
        focusManager.hide(mainWindow)
      }
    },
    toggleDetachedWindows: () => {
      // Alt+Q 切换进阶面板；无可用 tab 模块时已由 hotkey-sync 注销，此处兜底守卫
      if (!ports.isAdvancedPanelAvailable()) return
      ports.toggleAdvancedPanelWindow()
    },
  }
}
