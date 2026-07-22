// electron/window-factory/helpers.ts — 窗口创建辅助函数 + 常量
//
// 从原 window-factory.ts 抽离的纯辅助函数：bounds 持久化、渲染进程加载、
// webview 弹窗拦截、窗口痕迹记录、User-Agent 解析、窗口 ID 反查等。
//
// 拆分原则：
//   - helpers.ts 不 import 任何窗口创建函数（避免循环依赖）。
//   - 各窗口文件（main-window / standalone-window / chat-window / popup-windows）
//     从 ./helpers.js import 所需辅助函数与常量。
//   - 全局可变窗口状态通过 ../window-state.js 的 windowState 对象共享。
//
// 注意：原 window-factory.ts 位于 electron/，__dirname 指向 electron/(dev)/out/main/(prod)。
// 现 helpers.ts 位于 electron/window-factory/，需向上回溯一层（path.resolve(..., '..')）
// 以保持 __dirname 语义与原文件一致，从而窗口文件中 path.join(__dirname, '../preload/...')
// 等路径无需修改。

import { app, BrowserWindow } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { getChatStore } from '../store/chat-store.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { type WindowTraceAction, type ChatWindowConfig } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { windowState } from '../window-state.js'
import {
  toggleMaximizeForWindow,
  setAlwaysOnTopForWindow,
} from '../ipc/window-control-ipc.js'

/** 应用窗口统一背景色（与渲染层主题色一致，避免启动白闪） */
export const WINDOW_BACKGROUND_COLOR = '#1f1719'

// electron-vite 将所有 main 进程代码打包到 out/main/index.js，
// import.meta.url 指向该文件，故 __dirname = out/main（与 main.ts 一致）。
// 注意：开发模式下 helpers.ts 位于 electron/window-factory/，但 electron-vite
// 会将 import.meta.url 映射到 out/main/index.js，所以无需手动回溯。
export const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 判断是否开发模式：使用 app.isPackaged 确保打包后判断准确
export const isDev = !app.isPackaged

// 获取 preload 脚本路径
// dev: out/preload/index.mjs（electron-vite 编译输出）
// prod: ../preload/index.mjs（与 main 同级目录）
export function getPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/index.mjs')
  }
  return path.join(__dirname, '../preload/index.mjs')
}

// 历史搜索独立窗口（单例，列举所有本地保存数据）
export const HISTORY_WINDOW_ID = 'history'
// 提示词库独立窗口（单例，不遮挡主页面）
export const PROMPT_WINDOW_ID = 'prompts'
// AI 应用独立窗口（单例，承载内置 AI/自定义供应商/自定义对话）
export const AI_APP_PROVIDER_WINDOW_ID = 'ai-app-provider'
// 引导独立窗口（单例，首次启动或「使用指南」入口）
export const ONBOARDING_WINDOW_ID = 'onboarding'

// 弹窗拒绝计数器（内存，不持久化，应用重启重置）
// key=URL origin 前缀（scheme + host），value=连续拒绝次数
const popupDenyCounter = new Map<string, number>()

/** 从完整 URL 提取 origin 前缀（scheme + host + '/'），用于白名单匹配与拒绝计数 */
function extractUrlOrigin(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}/`
  } catch {
    return url
  }
}

/**
 * 同步读取 popupWhitelist（避免 setWindowOpenHandler 内 await 导致时序问题）。
 * 通过模块顶部静态 import getAppSettings，调用为同步函数。
 * 注：不能用 require() —— electron-vite 打包后模块路径不存在。
 */
function getPopupWhitelistSync(): string[] {
  try {
    return getAppSettings().popupWhitelist || []
  } catch (e) {
    console.warn('[webview-popup] 读取 popupWhitelist 失败:', e)
    return []
  }
}

/** 获取调用方所在的 BrowserWindow */
export function getSenderWindow(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/**
 * 为窗口设置 bounds 持久化（防抖保存到 windowStore）
 * 同时监听 maximize/unmaximize/show/focus 事件，
 * 若窗口应保持置顶（state.alwaysOnTop）则重新应用，
 * 避免被 Windows 全屏窗口覆盖后失效。
 */
export function setupBoundsTracking(win: BrowserWindow, windowId: string): void {
  const debouncedSave = () => {
    const existing = windowState.boundsSaveTimers.get(windowId)
    if (existing) clearTimeout(existing)
    windowState.boundsSaveTimers.set(
      windowId,
      setTimeout(() => {
        const state = windowStore.getOrDefault(windowId)
        // 仅非最大化、非全屏状态时保存 bounds，避免全屏/最大化尺寸覆盖小窗口尺寸
        if (!state.isMaximized && !win.isFullScreen()) {
          state.bounds = win.getBounds()
        }
        // isMaximized 状态由手动切换逻辑维护，这里不覆盖
        windowStore.save(windowId, state)
        windowState.boundsSaveTimers.delete(windowId)
      }, 500),
    )
  }
  win.on('resize', debouncedSave)
  win.on('move', debouncedSave)

  // 重新应用置顶（Windows 上被全屏窗口/任务栏覆盖后常见失效原因）
  // 仅在 show/focus/restore 时重新应用——maximize/fullscreen 与置顶互为冲突状态，
  // 进入时主动取消，退出时不自动恢复（用户需手动按 F12 重新置顶）。
  const reapplyAlwaysOnTop = () => {
    if (win.isMaximized() || win.isFullScreen()) return
    const state = windowStore.getOrDefault(windowId)
    if (state.alwaysOnTop && !win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true, 'screen-saver')
    } else if (!state.alwaysOnTop && win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(false)
    }
  }
  win.on('show', reapplyAlwaysOnTop)
  win.on('focus', reapplyAlwaysOnTop)
  win.on('restore', reapplyAlwaysOnTop)

  // 最大化/全屏 → 自动取消置顶（冲突关系：两种状态不能共存）
  const cancelAlwaysOnTopOnConflict = () => {
    if (!win.isAlwaysOnTop()) return
    win.setAlwaysOnTop(false)
    const state = windowStore.getOrDefault(windowId)
    state.alwaysOnTop = false
    windowStore.save(windowId, state)
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, false)
    }
    console.log(`[helpers] 窗口 ${windowId} 进入最大化/全屏，自动取消置顶`)
  }
  win.on('maximize', cancelAlwaysOnTopOnConflict)
  win.on('enter-full-screen', cancelAlwaysOnTopOnConflict)

  // 窗口操作痕迹记录到 SQLite（集中处理，覆盖所有窗口类型）
  win.on('maximize', () => safeLogWindowTrace(windowId, 'maximize'))
  win.on('unmaximize', () => safeLogWindowTrace(windowId, 'unmaximize'))
  win.on('minimize', () => safeLogWindowTrace(windowId, 'minimize'))
  win.on('restore', () => safeLogWindowTrace(windowId, 'restore'))
  win.on('show', () => safeLogWindowTrace(windowId, 'show'))
  win.on('hide', () => {
    safeLogWindowTrace(windowId, 'hide')
    // 通知渲染层窗口已隐藏，用于自动收起展开的面板（底栏等）
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_HIDDEN)
    }
  })
}

/**
 * 为窗口的 webContents 注册 <webview> 弹窗拦截器。
 *
 * 关键点：BrowserWindow 的 webContents 与 <webview> 标签的 guest webContents
 * 是分离的——直接在 BrowserWindow.webContents 上 setWindowOpenHandler
 * 不会拦截 webview 内的 window.open() / target="_blank"。
 *
 * 正确做法：监听 did-attach-webview 事件（每次 <webview> 附加到 DOM 时触发），
 * 在该 webview 的 guest webContents 上注册 handler，让弹窗 URL 在当前 webview
 * 内导航（页面内跳转），避免弹出独立 BrowserWindow。
 */
export function attachWebviewPopupInterceptor(parentWebContents: Electron.WebContents): void {
  parentWebContents.on('did-attach-webview', (_e, wc) => {
    // 需求 8：Ctrl+click 放行 —— setWindowOpenHandler 内无法读取修饰键，
    // 通过 before-input-event 维护 per-webview Ctrl 按下状态。
    // setWindowOpenHandler 内若 ctrlPressed=true 且 URL 为 http(s)，放行新窗口。
    let ctrlPressed = false

    // 1. setWindowOpenHandler：拦截 window.open() / target="_blank"
    //    策略：
    //    a) 白名单放行（用户主动加入的登录/OAuth/验证页）
    //    b) 跨域 popup：自动放行为独立窗口（登录/OAuth/支付等典型场景，
    //       跨域 loadURL 易触发 ERR_FAILED 导致 guest 崩溃，独立窗口更安全）
    //    c) 同域 popup：deny + 页面内跳转（保留 session 与登录态）
    //    d) 拒绝计数：同域连续 3 次提示加白名单
    //    e) 需求 8：Ctrl+click 链接放行为独立窗口（用户主动行为）
    wc.setWindowOpenHandler((details) => {
      const url = details.url
      if (!url || url === 'about:blank') {
        console.log('[webview-popup] 拦截空白弹窗，已阻止')
        return { action: 'deny' }
      }

      // 0) 需求 8：Ctrl+click 放行 —— http(s) 链接且 Ctrl 当前按下时，允许新窗口
      //    判断时机：用户按住 Ctrl 点击链接 → 浏览器触发 window.open，
      //    此时 before-input-event 已捕获 Ctrl keydown，ctrlPressed=true
      if (ctrlPressed && (url.startsWith('http://') || url.startsWith('https://'))) {
        console.log('[webview-popup] Ctrl+click 放行新窗口:', url)
        const sessionWithPartition = wc.session as unknown as { getPartition?: () => string }
        const partition = sessionWithPartition.getPartition?.() || ''
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: partition ? { partition } : {},
          },
        }
      }

      // 1) 白名单检查（origin 前缀匹配）
      const origin = extractUrlOrigin(url)
      const whitelist = getPopupWhitelistSync()
      const isWhitelisted = whitelist.some(
        (prefix) => url.startsWith(prefix) || origin.startsWith(prefix),
      )

      if (isWhitelisted) {
        console.log('[webview-popup] 白名单允许弹窗:', url)
        // 允许弹独立窗口，继承当前 webview 的 partition 保证登录态共享
        // 注：session.getPartition() 运行时存在但未在 Electron 类型定义中声明，需类型断言
        const sessionWithPartition = wc.session as unknown as { getPartition?: () => string }
        const partition = sessionWithPartition.getPartition?.() || ''
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: partition ? { partition } : {},
          },
        }
      }

      // 2) 跨域 popup：自动放行为独立窗口
      //    跨域 loadURL 在 SPA 内易触发 ERR_FAILED (-2) 导致 guest 崩溃；
      //    而跨域 window.open 通常是登录/OAuth/支付等需要独立窗口的场景。
      //    通过 origin 比较（scheme+host）判断是否跨域，path/hash/query 不影响。
      let currentUrl = ''
      try { currentUrl = wc.getURL() } catch { /* guest 未就绪 */ }
      const currentOrigin = currentUrl ? extractUrlOrigin(currentUrl) : ''
      const isCrossOrigin = !!currentOrigin && origin !== currentOrigin
      if (isCrossOrigin) {
        console.log('[webview-popup] 跨域 popup 自动放行:', url, '当前:', currentUrl.slice(0, 80))
        const sessionWithPartition = wc.session as unknown as { getPartition?: () => string }
        const partition = sessionWithPartition.getPartition?.() || ''
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: partition ? { partition } : {},
          },
        }
      }

      // 3) 同域 popup：统计拒绝次数（按 origin 聚合）
      const denyCount = (popupDenyCounter.get(origin) || 0) + 1
      popupDenyCounter.set(origin, denyCount)
      console.log(`[webview-popup] 拦截同域弹窗 (${denyCount}次):`, url)

      // 4) 连续拒绝 ≥3 次：通知渲染层提示用户加白名单，并重置该 origin 计数避免重复打扰
      if (denyCount >= 3) {
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_POPUP_DENIED, {
          url,
          origin,
          count: denyCount,
        })
        popupDenyCounter.delete(origin)
      }

      // 5) 默认：deny + 页面内跳转（保留现有行为，保留 session 与登录态）
      // 不在主进程直接 wc.loadURL：主进程和渲染层的 loadURL 都通过 GUEST_VIEW_MANAGER_CALL IPC，
      // guest 死亡时均会 ERR_FAILED，但只有渲染层能触发 remount 恢复。
      // 因此统一通过 IPC 转发到渲染层，由 safeLoadURLWebview 处理（包含 fatal-failure remount 逻辑）。
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_POPUP_URL, { url, webContentsId: wc.id })
      return { action: 'deny' }
    })

    // 2. new-window：已废弃事件，setWindowOpenHandler 返回 deny 后不会触发，
    //    仅在极少数浏览器内部导航场景兜底。为兼容性保留，但不再无条件拦截 ——
    //    跨域场景已在 setWindowOpenHandler 中 allow，此处重复 preventDefault 会
    //    把已允许的窗口创建流程打断，导致登录页打不开。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wc as any).on('new-window', (e: Event, url: string, _frameName: string, disposition: string) => {
      // foreground-tab / background-tab 是同域链接打开（已由 setWindowOpenHandler 处理）
      // new-window 是真正的弹窗（已由 setWindowOpenHandler allow/deny）
      // 此处仅记录日志，不做任何拦截，避免与 setWindowOpenHandler 决策冲突
      console.log('[webview-popup] new-window 事件（已由 setWindowOpenHandler 处理，跳过）:', { url, disposition })
    })

    // 2.5 did-create-window：仅在 setWindowOpenHandler 返回 allow 后触发，
    //    表示独立窗口已创建完成。此处**不能 preventDefault** —— 窗口已存在，
    //    阻止会破坏登录/OAuth 流程。仅记录日志用于调试。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(wc as any).on('did-create-window', (_e: Event, win: unknown, url: string) => {
      console.log('[webview-popup] did-create-window: 独立窗口已创建（setWindowOpenHandler 已 allow）:', url)
      // 不做任何阻止，让窗口正常显示
    })

    // 3. before-input-event：应用内快捷键统一处理（主进程兜底，确保 webview 焦点时可用）。
    //    F11/F12 直接在主进程执行窗口控制；其余快捷键通过 IPC WEBVIEW_HOTKEY 转发渲染层执行。
    //    统一在主进程拦截的原因：<webview> DOM 事件的 before-input-event 对 Alt/Ctrl 组合键
    //    转发不稳定（Alt+1~9 / Ctrl+Tab 可能被系统或 guest 消费），主进程 guest webContents
    //    级别的 before-input-event 是 Electron 中最可靠的拦截点。
    wc.on('before-input-event', (e, input) => {
      // 需求 8：跟踪 Ctrl 按下/释放状态（keyDown + keyUp 均需处理）
      // 用于 setWindowOpenHandler 内 Ctrl+click 放行判断
      if (input.key === 'Control') {
        if (input.type === 'keyDown') ctrlPressed = true
        else if (input.type === 'keyUp') ctrlPressed = false
      }
      if (input.type !== 'keyDown') return
      const win = BrowserWindow.fromWebContents(parentWebContents)
      if (!win || win.isDestroyed()) return

      const mods = input.modifiers || []
      const hasAlt = mods.includes('alt')
      const hasCtrl = mods.includes('control') || mods.includes('ctrl')
      const hasShift = mods.includes('shift')
      const hasMeta = mods.includes('meta') || mods.includes('command')
      const key = input.key
      const code = input.code

      // 调试日志已关闭（噪声过大）。需要排查时取消下方注释即可。
      // if (hasAlt || hasCtrl || hasMeta) {
      //   console.log('[hotkey] before-input-event:', { key, code, mods, type: input.type })
      // }

      // F4：后退（排除 Alt 以避免与 Alt+F4 关闭窗口冲突）
      if (key === 'F4' && !hasCtrl && !hasAlt) {
        console.log('[hotkey] F4 → 后退')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navBack' })
        return
      }

      // F5：刷新当前标签
      if (key === 'F5' && !hasCtrl && !hasAlt) {
        console.log('[hotkey] F5 → 刷新')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navRefresh' })
        return
      }

      // F6：前进
      if (key === 'F6' && !hasCtrl && !hasAlt) {
        console.log('[hotkey] F6 → 前进')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navForward' })
        return
      }

      // F10：切换主题（light/dark）
      if (key === 'F10' && !hasCtrl && !hasAlt && !hasShift) {
        console.log('[hotkey] F10 → 切换主题')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleTheme' })
        return
      }

      // F11：最大化/还原
      if (key === 'F11' && !hasCtrl) {
        console.log('[hotkey] F11 → 最大化/还原')
        e.preventDefault()
        const windowId = findWindowIdByWin(win)
        const isMax = toggleMaximizeForWindow(win, windowId)
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, isMax)
        return
      }

      // F12：置顶/取消置顶（与最大化/全屏互斥，冲突时先退出最大化/全屏再置顶）
      if (key === 'F12' && !hasCtrl) {
        console.log('[hotkey] F12 → 置顶切换')
        e.preventDefault()
        // 最大化/全屏与置顶互斥：先退出最大化/全屏，再切换置顶
        if (win.isMaximized()) {
          win.unmaximize()
          // 手动同步渲染层最大化状态（unmaximize 事件处理器仅记日志不发 IPC）
          parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
        }
        if (win.isFullScreen()) {
          win.setFullScreen(false)
          // leave-full-screen 事件会自动同步渲染层全屏状态
        }
        const windowId = findWindowIdByWin(win)
        const next = !win.isAlwaysOnTop()
        const actual = setAlwaysOnTopForWindow(win, windowId, next)
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual)
        return
      }

      // Alt+1~9：切换到第 N 个标签（仅 Alt，无其它修饰键）
      if (hasAlt && !hasCtrl && !hasMeta && !hasShift) {
        let n: number | null = null
        if (code.startsWith('Digit')) {
          const parsed = parseInt(code.slice('Digit'.length), 10)
          if (parsed >= 1 && parsed <= 9) n = parsed
        } else if (code.startsWith('Numpad')) {
          const parsed = parseInt(code.slice('Numpad'.length), 10)
          if (parsed >= 1 && parsed <= 9) n = parsed
        }
        if (n != null) {
          console.log(`[hotkey] Alt+${n} → 切换标签 #${n}`)
          e.preventDefault()
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'switchTab', data: { index: n - 1 } })
          return
        }
      }

      // Ctrl+Tab / Ctrl+Shift+Tab：循环切换标签
      if (hasCtrl && key === 'Tab') {
        console.log(`[hotkey] Ctrl+Tab${hasShift ? '+Shift' : ''} → 循环切换标签(${hasShift ? '反向' : '正向'})`)
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'cycleTab', data: { reverse: hasShift } })
        return
      }

      // Ctrl+T：当前窗口独立（脱离当前标签为新窗口）
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 't') {
        console.log('[hotkey] Ctrl+T → 当前窗口独立（detachCurrent）')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'detachCurrent' })
        return
      }

      // Ctrl+W：关闭当前标签（无标签时不操作，不关闭窗口）
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'w') {
        console.log('[hotkey] Ctrl+W → 关闭当前标签')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'closeTab' })
        return
      }

      // Ctrl+G：切换手柄/键盘空间导航模式
      if (hasCtrl && !hasAlt && !hasShift && key.toLowerCase() === 'g') {
        console.log('[hotkey] Ctrl+G → 切换空间导航模式')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleSpatialNav' })
        return
      }

      // 反引号(` ~) 或 Shift+? 呼出快捷键说明窗口
      if (!hasAlt && !hasCtrl && !hasMeta && !hasShift && (key === '`' || key === '~' || code === 'Backquote')) {
        console.log('[hotkey] ` → 切换快捷键窗口')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openShortcuts' })
        return
      }
      if (!hasAlt && !hasCtrl && !hasMeta && hasShift && key === '?') {
        console.log('[hotkey] ? → 切换快捷键窗口')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openShortcuts' })
        return
      }
    })
  })
}

/**
 * 构建渲染进程加载 URL（附加 windowId 查询参数，可选 mode）
 */
function buildRendererUrl(windowId: string, mode?: string): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    const sep = process.env.ELECTRON_RENDERER_URL.includes('?') ? '&' : '?'
    let url = `${process.env.ELECTRON_RENDERER_URL}${sep}windowId=${windowId}`
    if (mode) url += `&mode=${mode}`
    return url
  }
  // 生产环境通过 loadFile 的 query 选项传递
  return '' // 空字符串表示用 loadFile
}

/**
 * 加载渲染进程页面（dev server 或打包文件）
 */
export function loadRenderer(win: BrowserWindow, windowId: string, mode?: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(buildRendererUrl(windowId, mode))
  } else {
    const query: Record<string, string> = { windowId }
    if (mode) query.mode = mode
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      query,
    })
  }
  // --dev-tools 模式：窗口加载后自动打开 DevTools
  if (windowState.autoOpenDevTools) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' })
    })
  }
}

/**
 * 记录窗口操作痕迹到 SQLite（安全包装，chatStore 未就绪或失败不抛错）。
 * 用于追踪 create/close/maximize/minimize/tab_switch/pin_toggle 等行为。
 */
export function safeLogWindowTrace(windowId: string, action: WindowTraceAction, detail?: unknown): void {
  try {
    getChatStore().logWindowTrace(windowId, action, detail)
  } catch (e) {
    // chatStore 未初始化等异常时记录 debug 日志，避免正常运行刷屏
    console.debug('[safeLogWindowTrace] 记录窗口痕迹失败:', e)
  }
}

/** 根据 windowForm 获取默认窗口尺寸 */
export function getFormBounds(form?: 'narrow' | 'standard' | 'wide'): { width: number; height: number } {
  switch (form) {
    case 'wide':
      return { width: 1000, height: 680 }
    case 'standard':
      return { width: 720, height: 640 }
    case 'narrow':
    default:
      return { width: 480, height: 760 }
  }
}

/** 根据 uaPreset + userAgent 解析最终的 User-Agent 字符串（返回 null 表示用 Electron 默认） */
export function resolveUserAgent(config: ChatWindowConfig): string | null {
  switch (config.uaPreset) {
    case 'safari-ios':
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    case 'chrome-desktop':
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    case 'custom':
      return config.userAgent?.trim() || null
    default:
      return null
  }
}

/** 通过 BrowserWindow 实例反查 windowId */
export function findWindowIdByWin(win: BrowserWindow): string | null {
  if (win === windowState.mainWindow) return MAIN_WINDOW_ID
  if (win === windowState.historyWindow) return HISTORY_WINDOW_ID
  if (win === windowState.promptWindow) return PROMPT_WINDOW_ID
  if (win === windowState.aiAppProviderWindow) return AI_APP_PROVIDER_WINDOW_ID
  if (win === windowState.onboardingWindow) return ONBOARDING_WINDOW_ID
  if (win === windowState.previewWindow) return 'preview'
  for (const [id, w] of windowState.detachedWindows) {
    if (w === win) return id
  }
  // AI 应用编辑窗口反查（按 platformId 多例，windowId = `ai-app-editor-${platformId}`）
  if (windowState.aiAppEditorWindows) {
    for (const [wid, w] of windowState.aiAppEditorWindows) {
      if (w === win) return `ai-app-editor-${wid}`
    }
  }
  return null
}

/**
 * 为窗口的主 webContents 注册 F11/F12 快捷键拦截。
 *
 * 适用场景：不含 <webview> 的窗口（如 chat 窗口）。含 webview 的主窗口由
 * attachWebviewPopupInterceptor 在 guest webContents 上注册 before-input-event，
 * 不含 webview 的窗口需在主 webContents 上单独注册，否则 Chromium 内置 F11
 * 全屏行为会拦截按键，导致渲染层 keydown 无法生效。
 *
 * F11 → 最大化/还原（主进程直接执行 + IPC 通知渲染层）
 * F12 → 置顶/取消置顶（同上）
 */
export function attachWindowHotkeyInterceptor(parentWebContents: Electron.WebContents): void {
  parentWebContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const win = BrowserWindow.fromWebContents(parentWebContents)
    if (!win || win.isDestroyed()) return

    const mods = input.modifiers || []
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const key = input.key

    // F11：最大化/还原
    if (key === 'F11' && !hasCtrl) {
      console.log('[hotkey] F11 → 最大化/还原 (window-level)')
      e.preventDefault()
      const windowId = findWindowIdByWin(win)
      const isMax = toggleMaximizeForWindow(win, windowId)
      parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, isMax)
      return
    }

    // F12：置顶/取消置顶
    if (key === 'F12' && !hasCtrl) {
      console.log('[hotkey] F12 → 置顶切换 (window-level)')
      e.preventDefault()
      if (win.isMaximized()) {
        win.unmaximize()
        parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
      }
      if (win.isFullScreen()) {
        win.setFullScreen(false)
      }
      const windowId = findWindowIdByWin(win)
      const next = !win.isAlwaysOnTop()
      const actual = setAlwaysOnTopForWindow(win, windowId, next)
      parentWebContents.send(IPC_CHANNELS.WIN_CONTROL_PIN_TOGGLED, actual)
      return
    }
  })
}
