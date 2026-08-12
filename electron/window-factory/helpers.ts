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

import { app, BrowserWindow, screen, type WebPreferences } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { windowStore, MAIN_WINDOW_ID } from '../store/window-store.js'
import { getChatStore } from '../store/chat-store.js'
import { type WindowTraceAction, type ChatWindowConfig } from '../shared/types.js'
import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { windowState } from '../window-state.js'
import {
  setAlwaysOnTopForWindow,
  toggleMaximizeForWindow,
} from '../ipc/window-control-ipc.js'
import { buildWindowConfig } from './window-config-builder.js'
import { accumulatedLinksStore } from '../store/accumulated-links-store.js'
import { getAppSettings } from '../store/app-settings-store.js'

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

// 获取 webview 访客页 preload 脚本路径
// 用于 webview 内的反检测覆盖（navigator.webdriver / chrome.runtime 等）
export function getWebviewPreloadPath(): string {
  if (isDev) {
    return path.resolve(__dirname, '../preload/webview.mjs')
  }
  return path.join(__dirname, '../preload/webview.mjs')
}

/**
 * 构建统一的 webPreferences 配置块。
 * 所有窗口共享 contextIsolation / nodeIntegration / sandbox / backgroundThrottling 默认值，
 * 各窗口通过 opts 指定 preload 路径与 webviewTag 开关。
 * 若需额外字段（如 additionalArguments），调用方可展开后覆盖。
 */
export function createDefaultWebPreferences(opts: {
  preload: string
  webviewTag?: boolean
}): WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    webviewTag: opts.webviewTag ?? false,
    preload: opts.preload,
  }
}

// 历史搜索独立窗口（单例，列举所有本地保存数据）
export const HISTORY_WINDOW_ID = 'history'
// 提示词库独立窗口（单例，不遮挡主页面）
export const PROMPT_WINDOW_ID = 'prompts'
// 进阶面板（单例，承载内置 AI/自定义供应商/自定义对话）
export const ADVANCED_PANEL_WINDOW_ID = 'advanced-panel'
// 引导独立窗口（单例，首次启动或「使用指南」入口）
export const ONBOARDING_WINDOW_ID = 'onboarding'
// 历史记录与下载管理独立窗口（单例，导航历史 + 下载管理）
export const HISTORY_DOWNLOAD_WINDOW_ID = 'history-download'

/** 从完整 URL 提取 origin 前缀（scheme + host + '/'），用于日志 */
function extractUrlOrigin(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}/`
  } catch {
    return url
  }
}

/**
 * 硬编码的登录/OAuth 域名白名单（仅放行需要独立窗口的认证流程）。
 * 不再使用用户可配置的三层白名单系统（全局 + 平台 + Profile）。
 */
const LOGIN_POPUP_WHITELIST: string[] = [
  // ChatGPT
  'https://auth.openai.com/',
  'https://auth0.openai.com/',
  'https://login.openai.com/',
  // Claude
  'https://auth.anthropic.com/',
  // Gemini
  'https://accounts.google.com/',
  'https://myaccount.google.com/',
  // 豆包
  'https://passport.volcengine.com/',
  // 文心一言
  'https://passport.baidu.com/',
  // 小米 Mimo
  'https://account.xiaomi.com/',
  'https://auth.mi.com/',
]

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
/**
 * 为窗口设置 maximize/unmaximize/alwaysOnTop 事件同步（不保存 bounds）。
 * 适用于浏览器窗口和进阶面板窗口：取消最大化时使用 WindowMaximizeManager
 * 的 centered70 等策略还原，不需要记忆 bounds。
 */
function setupMaximizeSync(win: BrowserWindow, windowId: string): void {
  // 重新应用置顶（Windows 上被全屏窗口/任务栏覆盖后常见失效原因）
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

  // 最大化/还原事件 → 同步 state + 渲染层按钮图标
  win.on('maximize', () => {
    safeLogWindowTrace(windowId, 'maximize')
    const state = windowStore.getOrDefault(windowId)
    if (!state.isMaximized) {
      state.isMaximized = true
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, true)
    }
  })
  win.on('unmaximize', () => {
    safeLogWindowTrace(windowId, 'unmaximize')
    const state = windowStore.getOrDefault(windowId)
    if (state.isMaximized) {
      state.isMaximized = false
      state.normalBounds = undefined
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
    }
  })
  win.on('minimize', () => safeLogWindowTrace(windowId, 'minimize'))
  win.on('restore', () => safeLogWindowTrace(windowId, 'restore'))
  win.on('show', () => safeLogWindowTrace(windowId, 'show'))
  win.on('hide', () => {
    safeLogWindowTrace(windowId, 'hide')
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WINDOW_HIDDEN)
    }
  })
}

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

  // 最大化/还原事件 → 同步 state + 渲染层按钮图标（统一处理，覆盖所有窗口类型）
  // OS 原生最大化（Win+Up、Aero Snap、双击标题栏）也会触发，需同步 state.isMaximized
  // 和 normalBounds，否则 state 与 win.isMaximized() 不一致，导致 bounds 持久化错误。
  // IPC 最大化由 WindowMaximizeManager 使用 setBounds 实现（不触发 'maximize' 事件），
  // 此处仅处理 OS 原生最大化，不会与 WindowMaximizeManager 冲突。
  win.on('maximize', () => {
    safeLogWindowTrace(windowId, 'maximize')
    const state = windowStore.getOrDefault(windowId)
    if (!state.isMaximized) {
      // OS 原生最大化：记录 normalBounds 供还原使用
      state.normalBounds = state.bounds
      state.isMaximized = true
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, true)
    }
  })
  win.on('unmaximize', () => {
    safeLogWindowTrace(windowId, 'unmaximize')
    const state = windowStore.getOrDefault(windowId)
    if (state.isMaximized) {
      state.isMaximized = false
      state.normalBounds = undefined
      windowStore.save(windowId, state)
    }
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WIN_CONTROL_MAXIMIZE_TOGGLED, false)
    }
  })
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
 * 为脱离窗口（chat / standalone / ai-app）附加统一的生命周期管理。
 *
 * 统一处理：
 *   1. bounds 持久化追踪（setupBoundsTracking）或轻量 maximize 事件同步
 *   2. focus 追踪（更新 windowState.lastFocusedWin）
 *   3. close 事件：持久化 isMaximized/alwaysOnTop（可选保存 bounds）到 windowStore
 *   4. closed 事件：从 windowState.detachedWindows 清理 + 可选自定义清理
 *
 * @param options.trackBounds 是否追踪并保存 bounds（默认 true）。
 *   设为 false 时仅追踪 maximize/unmaximize/alwaysOnTop 事件，不保存 bounds。
 *   适用于浏览器窗口和进阶面板窗口：取消最大化时使用 WindowMaximizeManager
 *   的 centered70 策略还原，不需要记忆 bounds。
 */
export function attachDetachedWindowLifecycle(
  win: BrowserWindow,
  windowId: string,
  onClosed?: () => void,
  options?: { trackBounds?: boolean },
): void {
  const trackBounds = options?.trackBounds ?? true

  if (trackBounds) {
    setupBoundsTracking(win, windowId)
  } else {
    setupMaximizeSync(win, windowId)
  }

  win.on('focus', () => {
    windowState.lastFocusedWin = win
  })

  win.on('close', () => {
    const state = windowStore.getOrDefault(windowId)
    if (!win.isDestroyed()) {
      if (trackBounds && !win.isMaximized()) {
        state.bounds = win.getBounds()
      }
      state.isMaximized = win.isMaximized()
      state.alwaysOnTop = win.isAlwaysOnTop()
      windowStore.save(windowId, state)
    }
    safeLogWindowTrace(windowId, 'close')
  })

  win.on('closed', () => {
    windowState.detachedWindows.delete(windowId)
    onClosed?.()
  })
}

/**
 * 为窗口的 webContents 注册 <webview> 反检测 preload 注入。
 *
 * 通过 will-attach-webview 事件（webview 附加前触发），强制设置 preload 脚本，
 * 在页面脚本执行前覆盖 navigator.webdriver / window.chrome 等特征属性，
 * 防止 DeepSeek 等网站识别出 Electron/WebView 环境。
 */
export function attachWebviewAntiDetection(parentWebContents: Electron.WebContents): void {
  const webviewPreload = getWebviewPreloadPath()
  parentWebContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.preload = webviewPreload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = false
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
  // 弹窗拦截计数器：per-origin 连续被拦截次数，达到阈值时通知渲染层提示用户加白
  const popupDenialCount = new Map<string, number>()
  const POPUP_DENIAL_THRESHOLD = 3

  parentWebContents.on('did-attach-webview', (_e, wc) => {
    // 需求 8：Ctrl+click 放行 —— setWindowOpenHandler 内无法读取修饰键，
    // 通过 before-input-event 维护 per-webview Ctrl 按下状态。
    // setWindowOpenHandler 内若 ctrlPressed=true 且 URL 为 http(s)，放行新窗口。
    let ctrlPressed = false

    // 1. setWindowOpenHandler：拦截 window.open() / target="_blank"
    //    策略：
    //    a) Ctrl+click 放行（用户主动行为）
    //    b) 登录/OAuth 域名白名单放行（硬编码，不需要用户配置）
    //    c) 其余所有 popup：deny + 页面内跳转（保留 session 与登录态）
    wc.setWindowOpenHandler((details) => {
      const url = details.url
      if (!url || url === 'about:blank') {
        console.log('[webview-popup] 拦截空白弹窗，已阻止')
        return { action: 'deny' }
      }

      // Ctrl+click 放行 —— http(s) 链接且 Ctrl 当前按下时，允许新窗口
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

      // 登录/OAuth 域名白名单放行（origin 前缀匹配）
      const origin = extractUrlOrigin(url)
      const isLoginDomain = LOGIN_POPUP_WHITELIST.some(
        (prefix) => url.startsWith(prefix) || origin.startsWith(prefix),
      )
      if (isLoginDomain) {
        console.log('[webview-popup] 登录域放行:', url)
        const sessionWithPartition = wc.session as unknown as { getPartition?: () => string }
        const partition = sessionWithPartition.getPartition?.() || ''
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: partition ? { partition } : {},
          },
        }
      }

      // 其余 popup 一律 deny + 页面内跳转（跨域/同域均走此路径）
      console.log('[webview-popup] 拦截 popup，页面内跳转:', url)
      parentWebContents.send(IPC_CHANNELS.WEBVIEW_POPUP_URL, { url, webContentsId: wc.id })

      // E1：主窗口 AI 应用模式 —— 累积被拦截的新窗口链接到后台。
      // 当用户将 AI 应用独立为浏览器窗口时，BrowserView 初始化后会通过 consume
      // 取出全部累积链接并转为标签页。浏览器窗口模式（mode=browser）不累积，
      // 保持现有行为（关闭时通过 BROWSER_TAB_MIGRATE_BACK 迁移）。
      const parentUrl = parentWebContents.getURL?.() || ''
      const isMainWindowMode = !parentUrl.includes('mode=browser')
      if (isMainWindowMode) {
        try {
          const sessionWithPartition = wc.session as unknown as { getPartition?: () => string }
          const partition = sessionWithPartition.getPartition?.() || ''
          const profileId = partition.startsWith('persist:')
            ? partition.slice('persist:'.length)
            : ''
          if (profileId) {
            const persistent = getAppSettings().browserTabPersistence === 'persistent'
            // 拦截时无页面 title，暂用 URL 作为 title；BrowserView 消费后由 webview 加载
            // 页面时 page-title-updated 事件自动更新为真实标题
            accumulatedLinksStore.add(profileId, url, url, persistent)
            console.log('[webview-popup] E1 累积链接:', { profileId, url, persistent })
          }
        } catch (e) {
          console.warn('[webview-popup] E1 累积链接失败:', e)
        }
      }

      // 弹窗拦截计数：连续拦截同一 origin 达到阈值后通知渲染层提示用户加白
      const denialCount = (popupDenialCount.get(origin) ?? 0) + 1
      popupDenialCount.set(origin, denialCount)
      if (denialCount === POPUP_DENIAL_THRESHOLD) {
        parentWebContents.send(IPC_CHANNELS.POPUP_DENIED, { origin, count: denialCount })
      }

      return { action: 'deny' }
    })

    // 2. new-window：已废弃事件，setWindowOpenHandler 返回 deny 后不会触发，
    //    仅在极少数浏览器内部导航场景兜底。为兼容性保留，仅记录日志。
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
    //    F12 直接在主进程执行窗口控制；其余快捷键通过 IPC WEBVIEW_HOTKEY 转发渲染层执行。
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

      // F4：后退（排除 Alt 以避免与 Alt+F4 关闭窗口冲突）
      if (key === 'F4' && !hasCtrl && !hasAlt) {
        console.log('[hotkey] F4 → 后退')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navBack' })
        return
      }

      // Ctrl+Shift+R 或 Ctrl+F5：强制刷新（清除缓存）
      if (
        !hasAlt &&
        ((hasCtrl && hasShift && key.toLowerCase() === 'r') || (hasCtrl && key === 'F5'))
      ) {
        console.log('[hotkey] Ctrl+Shift+R/Ctrl+F5 → 强制刷新')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'forceRefresh' })
        return
      }

      // F5：刷新当前标签
      if (key === 'F5' && !hasCtrl && !hasAlt) {
        console.log('[hotkey] F5 → 刷新')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'navRefresh' })
        return
      }

      // F6：通过 IPC 转发到渲染层处理（主窗口聚焦 AI 输入框，浏览器窗口循环聚焦）
      if (key === 'F6' && !hasCtrl && !hasAlt && !hasShift) {
        console.log('[hotkey] F6 → 聚焦循环')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'focusCycle' })
        return
      }

      // F10：切换主题（light/dark）
      if (key === 'F10' && !hasCtrl && !hasAlt && !hasShift) {
        console.log('[hotkey] F10 → 切换主题')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleTheme' })
        return
      }

      // F11：切换最大化/还原（接入 WindowMaximizeManager，等效 TitleBar 最大化按钮）
      // 统一在主进程直接处理，避免 webview 焦点时渲染层收不到 keydown。
      // 调用 toggleMaximizeForWindow（与 IPC WIN_CONTROL_MAXIMIZE_TOGGLE 同一入口），
      // 保证图标变化（WIN_CONTROL_MAXIMIZE_TOGGLED 广播）和实现效果（按窗口类型应用
      // 还原策略：主窗口 normalBounds / 浏览器+进阶面板 centered70）完全一致。
      if (key === 'F11' && !hasCtrl && !hasAlt && !hasShift) {
        console.log('[hotkey] F11 → 切换最大化')
        e.preventDefault()
        const winId = findWindowIdByWin(win)
        toggleMaximizeForWindow(win, winId)
        return
      }

      // F12：浏览器窗口中切换 DevTools，其他窗口置顶/取消置顶
      if (key === 'F12' && !hasCtrl) {
        // 冻结期间短路 F12：debugger 已占用，开 DevTools 会冲突
        const wcId = wc.id
        const { isFrozen } = require('../freeze/freeze-manager.js') as typeof import('../freeze/freeze-manager.js')
        // 按 webContentsId 反查 tabId 较重，这里用「任意冻结中」粗判即可（冻结态本就罕见）
        if (wcId !== undefined) {
          const { getRecordByWebContentsId } = require('../freeze/webview-registry.js') as typeof import('../freeze/webview-registry.js')
          const rec = getRecordByWebContentsId(wcId)
          if (rec && isFrozen(rec.tabId)) {
            console.log('[hotkey] F12 跳过：该 webview 处于冻结态')
            e.preventDefault()
            return
          }
        }

        // 判断是否为浏览器窗口（URL 含 mode=browser）
        const winUrl = parentWebContents.getURL?.() || ''
        const isBrowserWindow = winUrl.includes('mode=browser')

        if (isBrowserWindow) {
          // 浏览器窗口：通知渲染层切换 DevTools
          console.log('[hotkey] F12 → DevTools 切换 (browser window)')
          e.preventDefault()
          parentWebContents.send(IPC_CHANNELS.BROWSER_TOGGLE_DEVTOOLS)
          return
        }

        // 非浏览器窗口：置顶/取消置顶
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
        // Alt+P：冻结/恢复当前页面（防撤回保险，浏览器窗口专用）
        if (key.toLowerCase() === 'p') {
          console.log('[hotkey] Alt+P → 冻结/恢复当前页面')
          e.preventDefault()
          parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleFreeze' })
          return
        }
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

      // Ctrl+D：添加当前页面到书签
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'd') {
        console.log('[hotkey] Ctrl+D → 添加书签')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'addBookmark' })
        return
      }

      // Ctrl+H：打开历史标签
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'h') {
        console.log('[hotkey] Ctrl+H → 打开历史')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openHistory' })
        return
      }

      // Ctrl+J：打开下载标签
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'j') {
        console.log('[hotkey] Ctrl+J → 打开下载')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'openDownloads' })
        return
      }

      // Ctrl+K / Ctrl+E：聚焦地址栏并进入搜索模式
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && (key.toLowerCase() === 'k' || key.toLowerCase() === 'e')) {
        console.log(`[hotkey] Ctrl+${key.toUpperCase()} → 聚焦搜索`)
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'focusSearch' })
        return
      }

      // Ctrl+Shift+Del：清除浏览数据
      if (hasCtrl && hasShift && !hasAlt && !hasMeta && key === 'Delete') {
        console.log('[hotkey] Ctrl+Shift+Del → 清除浏览数据')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'clearBrowsingData' })
        return
      }

      // Ctrl+F：页内查找
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'f') {
        console.log('[hotkey] Ctrl+F → 页内查找')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'findInPage' })
        return
      }

      // Ctrl+P：打印当前页面
      if (hasCtrl && !hasShift && !hasAlt && !hasMeta && key.toLowerCase() === 'p') {
        console.log('[hotkey] Ctrl+P → 打印')
        e.preventDefault()
        parentWebContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'print' })
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
 * 构建渲染进程加载 URL（附加 windowId 查询参数，可选 mode + extraQuery）
 */
function buildRendererUrl(
  windowId: string,
  mode?: string,
  extraQuery?: Record<string, string>,
): string {
  if (process.env.ELECTRON_RENDERER_URL) {
    const sep = process.env.ELECTRON_RENDERER_URL.includes('?') ? '&' : '?'
    const params = new URLSearchParams({ windowId })
    if (mode) params.set('mode', mode)
    if (extraQuery) {
      for (const [k, v] of Object.entries(extraQuery)) params.set(k, v)
    }
    return `${process.env.ELECTRON_RENDERER_URL}${sep}${params.toString()}`
  }
  // 生产环境通过 loadFile 的 query 选项传递
  return '' // 空字符串表示用 loadFile
}

/**
 * 加载渲染进程页面（dev server 或打包文件）
 */
export function loadRenderer(
  win: BrowserWindow,
  windowId: string,
  mode?: string,
  extraQuery?: Record<string, string>,
): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(buildRendererUrl(windowId, mode, extraQuery))
  } else {
    const query: Record<string, string> = { windowId }
    if (mode) query.mode = mode
    if (extraQuery) Object.assign(query, extraQuery)
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
  if (win === windowState.advancedPanelWindow) return ADVANCED_PANEL_WINDOW_ID
  if (win === windowState.onboardingWindow) return ONBOARDING_WINDOW_ID
  if (win === windowState.historyDownloadWindow) return HISTORY_DOWNLOAD_WINDOW_ID
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
 * 为窗口的主 webContents 注册 F12 快捷键拦截。
 *
 * 适用场景：不含 <webview> 的窗口（如 chat 窗口）。含 webview 的主窗口由
 * attachWebviewPopupInterceptor 在 guest webContents 上注册 before-input-event，
 * 不含 webview 的窗口需在主 webContents 上单独注册，否则 Chromium 内置 F12
 * 行为会拦截按键，导致渲染层 keydown 无法生效。
 *
 * F12 → 置顶/取消置顶（主进程直接执行 + IPC 通知渲染层）
 */
export function attachWindowHotkeyInterceptor(parentWebContents: Electron.WebContents): void {
  parentWebContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const win = BrowserWindow.fromWebContents(parentWebContents)
    if (!win || win.isDestroyed()) return

    const mods = input.modifiers || []
    const hasCtrl = mods.includes('control') || mods.includes('ctrl')
    const key = input.key

    // F11：切换最大化/还原（接入 WindowMaximizeManager，等效 TitleBar 最大化按钮）
    // 与 attachWebviewPopupInterceptor 中的 F11 处理一致，统一走 toggleMaximizeForWindow
    if (key === 'F11' && !hasCtrl && !mods.includes('alt') && !mods.includes('shift')) {
      console.log('[hotkey] F11 → 切换最大化 (window-level)')
      e.preventDefault()
      const winId = findWindowIdByWin(win)
      toggleMaximizeForWindow(win, winId)
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
