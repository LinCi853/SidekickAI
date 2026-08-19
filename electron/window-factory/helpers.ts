// electron/window-factory/helpers.ts — 窗口创建辅助函数 + 常量（聚合入口）
//
// 从原 window-factory.ts 抽离的纯辅助函数已按职责拆分为多个模块：
//   - constants.ts              窗口背景色 + 独立窗口 ID
//   - paths.ts                  __dirname / isDev / preload 路径
//   - web-preferences.ts        createDefaultWebPreferences
//   - window-events.ts          bounds 持久化 / maximize 同步 / 脱离窗口生命周期 / 窗口级快捷键
//   - renderer-loader.ts        渲染进程 URL 构建与加载
//   - singleton-popup.ts        单例弹出窗口工厂
//   - window-utils.ts           痕迹记录 / 表单尺寸 / UA 解析 / 窗口 ID 反查
//   - webview-hotkeys.ts        webview 应用内快捷键路由
//   - webview-anti-detection.ts webview 反检测 preload 注入
//
// 本文件保留 webview 弹窗拦截器（attachWebviewPopupInterceptor）本身，并作为
// 向后兼容的聚合入口，re-export 上述模块的全部导出。
//
// 拆分原则：
//   - helpers.ts 不 import 任何窗口创建函数（避免循环依赖）。
//   - 各窗口文件（main-window / standalone-window / chat-window / popup-windows）
//     从 ./helpers.js import 所需辅助函数与常量。
//   - 全局可变窗口状态通过 ../window-state.js 的 windowState 对象共享。

import { IPC_CHANNELS } from '../shared/ipc-channels.js'
import { accumulatedLinksStore } from '../store/accumulated-links-store.js'
import { getAppSettings } from '../store/app-settings-store.js'
import { isBrowserWindowContents } from './renderer-loader.js'
import { attachWebviewHotkeyRouter } from './webview-hotkeys.js'

// —— 常量 ——
export {
  WINDOW_BACKGROUND_COLOR,
  HISTORY_WINDOW_ID,
  PROMPT_WINDOW_ID,
  ADVANCED_PANEL_WINDOW_ID,
  ONBOARDING_WINDOW_ID,
  HISTORY_DOWNLOAD_WINDOW_ID,
} from './constants.js'

// —— 路径 ——
export { __dirname, isDev, getPreloadPath, getWebviewPreloadPath } from './paths.js'

// —— webPreferences ——
export { createDefaultWebPreferences } from './web-preferences.js'

// —— 窗口生命周期 ——
export {
  setupBoundsTracking,
  attachDetachedWindowLifecycle,
  getSenderWindow,
  attachWindowHotkeyInterceptor,
} from './window-events.js'

// —— 渲染进程加载 ——
export { isBrowserWindowContents, loadRenderer } from './renderer-loader.js'

// —— 单例弹出窗口 ——
export { createSingletonPopupWindow } from './singleton-popup.js'

// —— 杂项工具 ——
export {
  safeLogWindowTrace,
  getFormBounds,
  resolveUserAgent,
  findWindowIdByWin,
} from './window-utils.js'

// —— webview 快捷键路由 ——
export { attachWebviewHotkeyRouter } from './webview-hotkeys.js'

// —— webview 反检测 ——
export { attachWebviewAntiDetection } from './webview-anti-detection.js'

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
      const isMainWindowMode = !isBrowserWindowContents(parentWebContents)
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
    //    已抽离到 webview-hotkeys.ts 的 attachWebviewHotkeyRouter。
    //    通过回调同步 Ctrl 按下/释放状态，供上方 setWindowOpenHandler 的 Ctrl+click 放行判断。
    attachWebviewHotkeyRouter(wc, parentWebContents, (pressed) => {
      ctrlPressed = pressed
    })
  })
}
