// electron/voice/preview-window.ts — 后台语音录音指示器（预览窗）+ 应用前台焦点追踪
//
// 从 main.ts 抽离：
//   - createRecordIndicatorWindow：frameless 长条形透明窗（录音指示器）
//   - showPreview / positionPreviewAtBottomCenter / hidePreviewDelayed / hidePreview
//   - initAppFocusTracker / hasAppFocusedWindow：用于决定语音识别后是注入到应用内
//     webview 还是写入剪贴板（动态判断，不缓存焦点状态）
//
// 预览窗状态（previewHideTimer / latestPreviewState / appHasFocusedWindow）保留本文件，
// 仅本模块与 background-voice.ts（通过 hasAppFocusedWindow）使用。
//
// lifecycle.ts 退出清理通过 clearPreviewHideTimer() 暴露。

import { app, BrowserWindow, screen } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'
import { windowState } from '../window-state.js'
import { getPreloadPath, loadRenderer } from '../window-factory/helpers.js'

/** 后台语音预览窗自动隐藏延迟（毫秒） */
const PREVIEW_HIDE_DELAY_MS = 3000

/** 预览窗自动隐藏定时器 */
let previewHideTimer: NodeJS.Timeout | null = null

/** 最新预览状态（用于 dom-ready 后补发，防止首次创建时消息丢失） */
let latestPreviewState: {
  status: 'recording' | 'transcribing' | 'done' | 'sent'
  text: string
} = { status: 'recording', text: '' }

/**
 * 应用前台状态：true 表示至少有一个 BrowserWindow 当前处于 focus
 * 用于决定语音识别后是注入到应用内 webview 还是写入剪贴板
 */
let appHasFocusedWindow = false

/**
 * 初始化前台状态追踪。
 * 在 app.whenReady() 后调用一次即可。
 */
export function initAppFocusTracker(): void {
  // 初始状态：检查当前是否有窗口已 focus
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isFocused()) {
      appHasFocusedWindow = true
      break
    }
  }
  // 监听所有窗口的 focus/blur 事件
  app.on('browser-window-focus', () => {
    appHasFocusedWindow = true
  })
  app.on('browser-window-blur', () => {
    // 延迟一帧查询：可能是用户切到本应用的其他窗口，需要重新检查
    setImmediate(() => {
      let anyFocused = false
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && w.isFocused()) {
          anyFocused = true
          break
        }
      }
      appHasFocusedWindow = anyFocused
    })
  })
}

/** 判断应用当前是否处于前台（有 BrowserWindow 处于 focus） */
export function hasAppFocusedWindow(): boolean {
  return appHasFocusedWindow
}

/**
 * 创建后台语音录音指示器（frameless 长条形透明窗，alwaysOnTop，skipTaskbar）。
 * 长条形窗口显示：录音状态图标 + 实时音量波形 + 状态文字/识别结果。
 * ?windowId=preview&mode=record-indicator → RecordIndicator 路由。
 * 首次创建后复用（hide/show），不重复创建。
 */
function createRecordIndicatorWindow(): BrowserWindow {
  // 长条形窗口：宽 360px，高 56px，圆角胶囊形
  // 放开大小限制，允许 resize（但默认尺寸固定）
  //
  // 平台差异：
  //   - macOS：transparent:true 需配合 visualEffectState:'active' 维持激活态毛玻璃
  //   - Linux：transparent 在 Wayland 下黑屏，关闭并用深色背景模拟胶囊
  //   - Windows：保持原透明胶囊行为
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const win = new BrowserWindow({
    width: 360,
    height: 56,
    minWidth: 240,
    minHeight: 48,
    maxWidth: 720,
    maxHeight: 120,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: isLinux ? '#1e1e1e' : 'rgba(0, 0, 0, 0)',
    hasShadow: false,
    // Linux 关闭透明避免黑屏；macOS/Windows 保持透明胶囊
    transparent: !isLinux,
    // Windows 专属字段
    ...(process.platform === 'win32'
      ? { backgroundMaterial: 'none' as const, thickFrame: false }
      : {}),
    // macOS 透明窗口需激活态毛玻璃，否则可能显示异常
    ...(isMac ? { visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })

  loadRenderer(win, 'preview', 'record-indicator')

  win.on('closed', () => {
    if (windowState.previewWindow === win) windowState.previewWindow = null
  })

  return win
}

/**
 * 显示预览窗并更新内容。
 * 若窗口不存在则创建；存在则复用。
 * 首次创建时等待 dom-ready 后再发送状态，避免消息丢失。
 */
export function showPreview(payload: {
  status: 'recording' | 'transcribing' | 'done' | 'sent'
  text: string
}): void {
  latestPreviewState = payload
  let isNew = false
  if (!windowState.previewWindow || windowState.previewWindow.isDestroyed()) {
    windowState.previewWindow = createRecordIndicatorWindow()
    isNew = true
  }
  // 取消待隐藏定时器
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
  const win = windowState.previewWindow

  const sendUpdate = () => {
    try {
      win.webContents.send(IPC_CHANNELS.PREVIEW_UPDATE, latestPreviewState)
    } catch (err) {
      console.error('[main] PREVIEW_UPDATE 发送失败:', err)
    }
  }

  if (isNew) {
    // 新创建窗口：等 dom-ready 后再发，确保渲染层监听器已注册
    // 关键：必须先注册监听器再检查 isLoading()，否则 dom-ready 可能已经触发过
    const onReady = () => {
      if (win.isDestroyed()) return
      positionPreviewAtBottomCenter(win)
      sendUpdate()
      if (!win.isVisible()) {
        win.show()
      }
    }
    if (!win.webContents.isLoading()) {
      // dom-ready 已触发过：直接发（监听器会丢失事件）
      onReady()
    } else {
      win.webContents.once('dom-ready', onReady)
    }
  } else {
    positionPreviewAtBottomCenter(win)
    sendUpdate()
    if (!win.isVisible()) {
      win.show()
    }
  }
}

/**
 * 把预览窗定位到主显示器底部居中（长条形胶囊窗口，悬浮在屏幕底部）
 * 距屏幕底部 80px，避免遮挡任务栏
 * 使用窗口当前实际尺寸（用户可 resize），仅居中 x 轴
 */
function positionPreviewAtBottomCenter(win: BrowserWindow): void {
  try {
    const display = screen.getPrimaryDisplay()
    const { width: sw, height: sh } = display.workAreaSize
    const { x: sx, y: sy } = display.workArea
    const [winW, winH] = win.getSize()
    const x = sx + Math.round((sw - winW) / 2)
    const y = sy + sh - winH - 80
    win.setBounds({ x, y, width: winW, height: winH })
  } catch (e) {
    console.warn('[main] 定位预览窗失败:', e)
  }
}

/** 3 秒后隐藏预览窗（不销毁，复用） */
export function hidePreviewDelayed(): void {
  if (previewHideTimer) clearTimeout(previewHideTimer)
  previewHideTimer = setTimeout(() => {
    if (windowState.previewWindow && !windowState.previewWindow.isDestroyed() && windowState.previewWindow.isVisible()) {
      try {
        windowState.previewWindow.webContents.send(IPC_CHANNELS.PREVIEW_HIDE)
      } catch (err) {
        console.error('[main] PREVIEW_HIDE 发送失败:', err)
      }
      windowState.previewWindow.hide()
    }
    previewHideTimer = null
  }, PREVIEW_HIDE_DELAY_MS)
}

/**
 * 立即隐藏预览窗（录音指示器），不等待延迟。
 * 识别成功后调用，避免指示器与自动上屏动作同时出现。
 */
export function hidePreview(): void {
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
  if (windowState.previewWindow && !windowState.previewWindow.isDestroyed() && windowState.previewWindow.isVisible()) {
    try {
      windowState.previewWindow.webContents.send(IPC_CHANNELS.PREVIEW_HIDE)
    } catch (err) {
      console.error('[main] PREVIEW_HIDE 发送失败:', err)
    }
    windowState.previewWindow.hide()
  }
}

/** 清理挂起的预览窗隐藏定时器（lifecycle.ts 退出清理时调用） */
export function clearPreviewHideTimer(): void {
  if (previewHideTimer) {
    clearTimeout(previewHideTimer)
    previewHideTimer = null
  }
}
