// electron/window-factory/singleton-popup.ts — 单例弹出窗口工厂
//
// 从 helpers.ts 抽离：创建单例弹出窗口的通用工厂。

import { BrowserWindow, screen } from 'electron'
import { windowStore } from '../store/window-store.js'
import { buildWindowConfig } from './window-config-builder.js'
import { WINDOW_BACKGROUND_COLOR } from './constants.js'
import { createDefaultWebPreferences } from './web-preferences.js'
import { getPreloadPath } from './paths.js'
import { loadRenderer } from './renderer-loader.js'
import { setupBoundsTracking, attachWindowHotkeyInterceptor } from './window-events.js'
import { safeLogWindowTrace } from './window-utils.js'

/**
 * 创建单例弹出窗口的通用工厂。
 *
 * 统一 popup-windows.ts 中 4 个弹出窗口的共同模式：
 *   1. 单例检查（已存在则聚焦返回）
 *   2. 居中位置计算（clamp 到工作区）
 *   3. buildWindowConfig + createDefaultWebPreferences
 *   4. loadRenderer 加载渲染进程
 *   5. attachWindowHotkeyInterceptor 注册 F12 拦截
 *   6. ready-to-show 显示聚焦
 *   7. closed 清理单例引用
 *
 * 调用方通过 getExisting / setWindow 回调适配不同的单例存储方式
 * （windowState.xxxWindow 属性或 aiAppEditorWindows Map）。
 */
export function createSingletonPopupWindow(opts: {
  width: number
  height: number
  minWidth: number
  minHeight: number
  title: string
  windowId: string
  mode: string
  extraQuery?: Record<string, string>
  getExisting: () => BrowserWindow | null | undefined
  setWindow: (win: BrowserWindow | null) => void
}): BrowserWindow {
  // 1. 单例检查
  const existing = opts.getExisting()
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    if (!existing.isVisible()) existing.show()
    existing.focus()
    return existing
  }

  // 2. 位置计算：优先使用保存的 bounds，否则用默认尺寸居中
  //    与主窗口/进阶面板一致，弹出窗口也支持位置/大小记忆
  const saved = windowStore.getOrDefault(opts.windowId)
  const hasSavedBounds = !!windowStore.get(opts.windowId)
  const workArea = screen.getPrimaryDisplay().workArea
  const width = (hasSavedBounds && saved.bounds.width) || Math.min(opts.width, workArea.width - 80)
  const height = (hasSavedBounds && saved.bounds.height) || Math.min(opts.height, workArea.height - 80)
  const x = (hasSavedBounds && saved.bounds.x != null)
    ? saved.bounds.x
    : workArea.x + Math.round((workArea.width - width) / 2)
  const y = (hasSavedBounds && saved.bounds.y != null)
    ? saved.bounds.y
    : workArea.y + Math.round((workArea.height - height) / 2)

  // 3. 创建 BrowserWindow
  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x,
    y,
    minWidth: opts.minWidth,
    minHeight: opts.minHeight,
    show: false,
    frame: false,
    alwaysOnTop: saved.alwaysOnTop,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    title: opts.title,
    webPreferences: createDefaultWebPreferences({
      preload: getPreloadPath(),
      webviewTag: false,
    }),
  }))

  // 恢复最大化状态（与主窗口/进阶面板一致）
  if (saved.isMaximized) {
    win.maximize()
  }

  // 4. 缓存单例引用
  opts.setWindow(win)

  // 5. 加载渲染进程
  loadRenderer(win, opts.windowId, opts.mode, opts.extraQuery)

  // 6. F12 快捷键拦截（弹出窗口不含 webview）
  attachWindowHotkeyInterceptor(win.webContents)

  // 7. bounds 持久化 + 最大化/置顶事件追踪（与其他窗口同步）
  setupBoundsTracking(win, opts.windowId)

  // 8. close 事件：持久化 bounds + isMaximized + alwaysOnTop（与主窗口一致）
  win.on('close', () => {
    const state = windowStore.getOrDefault(opts.windowId)
    if (!win.isDestroyed()) {
      const isMax = win.isMaximized()
      if (!isMax && !win.isFullScreen()) {
        state.bounds = win.getBounds()
      }
      state.isMaximized = isMax
      state.alwaysOnTop = win.isAlwaysOnTop()
      windowStore.save(opts.windowId, state)
    }
    safeLogWindowTrace(opts.windowId, 'close')
  })

  // 9. ready-to-show
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // 10. closed 清理
  win.on('closed', () => {
    opts.setWindow(null)
  })

  return win
}
