// electron/window-factory/main-window.ts — 主窗口创建
//
// 从原 window-factory.ts 抽离的 createMainWindow。
// 函数体与原文件逐字一致，仅 import 来源调整为从 ./helpers.js 与上级模块。

import { app, BrowserWindow, screen } from 'electron'
import path from 'path'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { windowState } from '../window-state.js'
import * as focusManager from '../utils/focus-manager.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import {
  __dirname,
  getPreloadPath,
  createDefaultWebPreferences,
  attachWebviewPopupInterceptor,
  attachWebviewAntiDetection,
  loadRenderer,
  setupBoundsTracking,
  safeLogWindowTrace,
} from './helpers.js'
import { buildWindowConfig } from './window-config-builder.js'
import { calculateMainWindowMinWidth, getUiScaleFromSettings, MAIN_WINDOW_MIN_HEIGHT } from './window-size-helpers.js'

/**
 * 主窗口渲染层加载失败重试状态。
 * 用于在 did-fail-load 事件中追踪重试次数，避免无限循环。
 * 加载成功后（did-finish-load）会被重置为 null。
 */
let mainWindowLoadRetryState: { retries: number; lastUrl: string } | null = null

/**
 * 创建主 UI 窗口（多标签 + 顶栏 + 底栏）
 * 从 windowStore 恢复上次的位置/尺寸/置顶状态
 */
export function createMainWindow(): void {
  const saved = windowStore.getOrDefault(MAIN_WINDOW_ID)
  // 校验 tabs 数组：过滤掉 url 异常的 tab，防止 webview 挂载失败导致白屏
  windowStore.sanitizeTabs(MAIN_WINDOW_ID)
  const workArea = screen.getPrimaryDisplay().workArea

  const width = saved.bounds.width || 420
  const height = saved.bounds.height || 820

  // 根据 UI 比例 + 实际可见的顶栏按钮动态计算最小宽度
  const uiScale = getUiScaleFromSettings()
  const appSettings = getAppSettings()
  const minWidth = calculateMainWindowMinWidth(uiScale, appSettings.topBarVisibleButtons)

  const win = new BrowserWindow(buildWindowConfig({
    width,
    height,
    x: saved.bounds.x,
    y: saved.bounds.y,
    minWidth,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    frame: false,
    // resizable:true 让 setBounds 可自由缩小（Win32 需保留 WS_THICKFRAME 才能 resize）；
    // 原生 resize 边框由 thickFrame:false 禁用，用户无法通过窗口边缘拖拽 resize。
    resizable: true,
    alwaysOnTop: saved.alwaysOnTop,
    title: '工百窗',
    webPreferences: {
      ...createDefaultWebPreferences({
        preload: getPreloadPath(),
        webviewTag: true,
      }),
      // 启用 OverlayScrollbar 提供跨平台一致的滚动条外观
      additionalArguments: ['--enable-features=OverlayScrollbar'],
    },
  }))
  windowState.mainWindow = win
  focusManager.track(win)

  // 拦截 <webview> 内弹窗（target="_blank" / window.open()）
  // 必须通过 did-attach-webview 在 webview 的 guest webContents 上注册 handler，
  // BrowserWindow.webContents 的 handler 不拦截 webview 内的弹窗
  attachWebviewAntiDetection(win.webContents)
  attachWebviewPopupInterceptor(win.webContents)

  // 确保 x/y 在屏幕可视范围内
  if (
    saved.bounds.x != null &&
    saved.bounds.y != null &&
    saved.bounds.x < workArea.x + workArea.width - 100 &&
    saved.bounds.y < workArea.y + workArea.height - 100
  ) {
    win.setPosition(saved.bounds.x, saved.bounds.y)
  } else if (saved.bounds.x == null || saved.bounds.y == null) {
    // 首次启动（无保存位置）：默认显示在屏幕右侧四分之三区域居中
    const defaultX = Math.round(workArea.x + workArea.width * 0.75 - width / 2)
    const defaultY = Math.round(workArea.y + (workArea.height - height) / 2)
    try { win.setPosition(defaultX, defaultY) } catch { /* 忽略 */ }
  }
  if (saved.isMaximized) {
    win.maximize()
  }

  loadRenderer(win, MAIN_WINDOW_ID)

  win.once('ready-to-show', () => {
    // 恢复全屏状态（关闭时若为全屏，重开仍为全屏）
    if (saved.isFullscreen) {
      // 关键：在进入全屏前，先把当前 bounds（非全屏尺寸）保存为 fullscreenNormalBounds，
      // 这样退出全屏时 leave-full-screen 事件才能正确恢复到非全屏窗口大小
      const state = windowStore.getOrDefault(MAIN_WINDOW_ID)
      if (!state.fullscreenNormalBounds) {
        state.fullscreenNormalBounds = win.getBounds()
        windowStore.save(MAIN_WINDOW_ID, state)
      }
      win.setFullScreen(true)
    }
    // 同步初始最大化/全屏状态到渲染层，用于窗口圆角控制
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, win.isMaximized())
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, win.isFullScreen())
    }
    win.show()
    safeLogWindowTrace(MAIN_WINDOW_ID, 'create')
  })

  // 最大化/还原事件由 setupBoundsTracking 统一处理（所有窗口共用），此处不再重复监听

  // 全屏状态变化：持久化 isFullscreen + 还原全屏前 bounds
  // 注意：fullscreenNormalBounds 已在 WIN_CONTROL_TOGGLE_FULLSCREEN IPC handler 中
  // 于 setFullScreen(true) 之前正确记录，此处不再重复记录（enter-full-screen 触发时
  // win.getBounds() 已是全屏尺寸，直接使用会导致退出全屏时恢复到全屏尺寸）
  win.on('enter-full-screen', () => {
    const state = windowStore.getOrDefault(MAIN_WINDOW_ID)
    if (!win.isDestroyed()) {
      state.isFullscreen = true
      windowStore.save(MAIN_WINDOW_ID, state)
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, true)
    }
  })
  win.on('leave-full-screen', () => {
    const state = windowStore.getOrDefault(MAIN_WINDOW_ID)
    state.isFullscreen = false
    // 退出全屏后还原全屏前的尺寸（若曾记录）
    if (state.fullscreenNormalBounds && !win.isDestroyed()) {
      try {
        win.setBounds(state.fullscreenNormalBounds)
      } catch {
        // 忽略：窗口可能正在切换中
      }
      // 清空 fullscreenNormalBounds，下次进入全屏时重新记录
      state.fullscreenNormalBounds = undefined
    }
    windowStore.save(MAIN_WINDOW_ID, state)
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_FULLSCREEN_TOGGLED, false)
    }
  })

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[main] 渲染进程加载失败:', { code, desc, url })
    // 主框架加载失败重试逻辑：避免因瞬时故障或资源缺失导致永久白屏
    // ERR_ABORTED (-3) 是导航被取消的正常现象，忽略
    if (code === -3) return
    if (!mainWindowLoadRetryState) mainWindowLoadRetryState = { retries: 0, lastUrl: '' }
    const st = mainWindowLoadRetryState
    st.lastUrl = url
    if (st.retries >= 2) {
      console.error('[main] 渲染进程加载失败已达重试上限，加载兜底空白页避免永久白屏')
      try {
        win.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
          '<html><body style="font-family:sans-serif;padding:24px;color:#333">' +
          '<h2>窗口加载失败</h2><p>请尝试重启应用或检查网络代理设置。</p>' +
          '<p style="color:#999;font-size:12px">错误代码: ' + code + ' ' + (desc || '') + '</p>' +
          '</body></html>'
        ))
      } catch (e) {
        console.error('[main] 加载兜底页失败:', e)
      }
      return
    }
    st.retries += 1
    console.warn(`[main] 渲染进程加载失败，第 ${st.retries} 次重试...`)
    setTimeout(() => {
      if (win.isDestroyed()) return
      try {
        // 重试加载渲染入口
        loadRenderer(win, MAIN_WINDOW_ID)
      } catch (e) {
        console.error('[main] 重试加载失败:', e)
      }
    }, 300)
  })

  // 加载成功后重置重试计数
  win.webContents.on('did-finish-load', () => {
    if (mainWindowLoadRetryState) {
      mainWindowLoadRetryState = null
    }
  })

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] ?? 'LOG'
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })

  // bounds 持久化
  setupBoundsTracking(win, MAIN_WINDOW_ID)

  // 追踪最近聚焦窗口（置顶热键作用对象）
  win.on('focus', () => {
    windowState.lastFocusedWin = win
  })

  win.on('close', (e) => {
    // closeBehavior=minimize 时，拦截所有关闭路径（IPC / Alt+F4 / 任务栏），
    // 统一隐藏到托盘，避免窗口被销毁后无法通过 Alt+Space 恢复
    const settings = getAppSettings()
    const isQuitting = (app as unknown as { isQuitting?: boolean }).isQuitting
    if (settings.closeBehavior === 'minimize' && !isQuitting) {
      e.preventDefault()
      // minimize + skipTaskbar 彻底隐藏：屏幕、Alt+Tab、任务栏均不可见
      win.minimize()
      win.setSkipTaskbar(true)
      win.hide()
      console.log('[main] 主窗口隐藏到托盘（closeBehavior=minimize）')
      return
    }
    // 正常关闭：保存 bounds + isMaximized + alwaysOnTop + isFullscreen
    // 用 win.isMaximized() 而非 state.isMaximized，避免 OS 原生最大化时 state 未同步
    const state = windowStore.getOrDefault(MAIN_WINDOW_ID)
    if (!win.isDestroyed()) {
      const isFs = win.isFullScreen()
      const isMax = win.isMaximized()
      if (!isMax && !isFs) {
        state.bounds = win.getBounds()
      }
      state.isMaximized = isMax
      state.alwaysOnTop = win.isAlwaysOnTop()
      state.isFullscreen = isFs
      windowStore.save(MAIN_WINDOW_ID, state)
    }
    safeLogWindowTrace(MAIN_WINDOW_ID, 'close')
  })

  win.on('closed', () => {
    windowState.mainWindow = null
    // 走到这里说明窗口已被真正销毁（closeBehavior=close 或 app.quit）
    const settings = getAppSettings()
    if (settings.closeBehavior === 'close') {
      console.log('[main] 主窗口关闭，退出应用（closeBehavior=close）')
      app.quit()
    } else {
      console.log('[main] 主窗口关闭，退出应用（兜底退出）')
      app.quit()
    }
  })
}

/**
 * 将主窗口恢复到默认位置和大小（连续 3 次 Alt+Space 触发的防误触恢复）
 * - 取消最大化/全屏
 * - 恢复默认尺寸 420×820，居中显示在主屏幕工作区
 * - 保留置顶状态（用户设置）
 */
export function resetMainWindowToDefault(): void {
  const win = windowState.mainWindow
  if (!win || win.isDestroyed()) return

  // 取消全屏和最大化
  if (win.isFullScreen()) win.setFullScreen(false)
  if (win.isMaximized()) win.unmaximize()

  const workArea = screen.getPrimaryDisplay().workArea
  const defaultWidth = 420
  const defaultHeight = 820
  // 居中显示在主屏幕工作区
  const x = Math.round(workArea.x + (workArea.width - defaultWidth) / 2)
  const y = Math.round(workArea.y + (workArea.height - defaultHeight) / 2)

  try {
    win.setBounds({ x, y, width: defaultWidth, height: defaultHeight })
  } catch {
    // 忽略：窗口可能正在切换中
  }

  // 显示并聚焦
  win.setSkipTaskbar(false)
  if (!win.isVisible()) win.show()
  win.focus()

  // 持久化新的 bounds
  const state = windowStore.getOrDefault(MAIN_WINDOW_ID)
  state.bounds = { x, y, width: defaultWidth, height: defaultHeight }
  state.isMaximized = false
  state.isFullscreen = false
  state.fullscreenNormalBounds = undefined
  windowStore.save(MAIN_WINDOW_ID, state)

  console.log('[main] 主窗口已恢复默认位置和大小（Alt+Space 连续三次触发）')
}
