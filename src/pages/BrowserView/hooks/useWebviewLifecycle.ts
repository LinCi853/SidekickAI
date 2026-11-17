/* =====================================================================
   pages/BrowserView/hooks/useWebviewLifecycle.ts —— webview 生命周期
   抽取自 BrowserWebviewTab.tsx：15 个事件监听器（含注册/注销）、
   Owns page recovery, guest identity registration, DevTools and dropped files.
   ===================================================================== */

import { useCallback, useEffect, useRef } from 'react'
import type { BrowserTabState, Profile } from '../../../lib/electron-api'
import { registerWebview } from '../../../lib/electron-api'
import type { WebviewElement } from '../../../lib/webview.js'
import { safeReloadWebview } from '../../../lib/webview.js'
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js'
import { leaseWebviewLifecycle } from '../../../lib/webview-lifecycle'
import { BLANK_PAGE_PROBE_SCRIPT } from '../webview-scripts.js'

/** 加载结束后的白屏探测延迟，给站点首屏脚本留出渲染时间 */
const BLANK_PROBE_DELAY_MS = 1500
/** 切回标签时的探测延迟，给隐藏页面重绘留出时间 */
const BLANK_ACTIVATION_DELAY_MS = 600
/** 同一 URL 连续自动刷新上限 */
const BLANK_AUTO_RETRY_LIMIT = 2
/** 两次刷新之间的最小间隔，避免探测与事件重复触发连续刷新 */
const BLANK_RELOAD_DEDUPE_MS = 1000

interface BlankProbeResult {
  readyState?: string
  textLen?: number
  elementCount?: number
  htmlLen?: number
}

/** 只把“没有任何文本、元素几乎为空”的页面判为白屏，避免误伤骨架屏与纯画布页面 */
function isBlankPage(info: BlankProbeResult | null): boolean {
  if (!info) return false
  if (info.readyState !== 'complete' && info.readyState !== 'interactive') return false
  return (info.textLen ?? 0) === 0 && (info.elementCount ?? 0) <= 2 && (info.htmlLen ?? 0) <= 200
}

export interface UseWebviewLifecycleHandlers {
  handleDomReady: () => Promise<void>
  handleNavigate: (e: Event) => void
  handleTitleUpdate: (e: Event) => void
  handleFaviconUpdate: (e: Event) => void
  handleStartLoading: () => void
  handleStopLoading: () => void
  handleFinishNavigation: () => void
  handleFinishLoad: () => void
  handleFailLoad: () => void
  handleMediaStartedPlaying: () => void
  handleMediaPaused: () => void
}

export interface UseWebviewLifecycleParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>
  domReadyRef: React.MutableRefObject<boolean>
  remountKey: number
  setRemountKey: React.Dispatch<React.SetStateAction<number>>
  tab: BrowserTabState
  profile: Profile
  /** 标签是否为当前可见标签，用于切回时补做白屏检查 */
  active: boolean
  handlers: UseWebviewLifecycleHandlers
}

export function useWebviewLifecycle({
  webviewRef,
  domReadyRef,
  remountKey,
  setRemountKey,
  tab,
  profile,
  active,
  handlers,
}: UseWebviewLifecycleParams) {
  const {
    handleDomReady,
    handleNavigate,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleStartLoading,
    handleStopLoading,
    handleFinishNavigation,
    handleFinishLoad,
    handleFailLoad,
    handleMediaStartedPlaying,
    handleMediaPaused,
  } = handlers

  // Remount on fatal failure
  const handleFatalFailure = useCallback(() => {
    console.warn('[BrowserWebviewTab] fatal failure, remounting:', tab.url)
    domReadyRef.current = false
    setRemountKey((k) => k + 1)
  }, [tab.url])

  // Register event listeners
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const lifecycle = leaseWebviewLifecycle(webview, () => webviewRef.current)
    let recovering = false
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined
    const recoverOnce = () => {
      if (recovering) return
      recovering = true
      handleFatalFailure()
    }

    webview.addEventListener('dom-ready', handleDomReady as EventListener)
    webview.addEventListener('did-navigate', handleNavigate as EventListener)
    webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener)
    webview.addEventListener('page-title-updated', handleTitleUpdate as EventListener)
    webview.addEventListener('page-favicon-updated', handleFaviconUpdate as EventListener)
    webview.addEventListener('did-start-loading', handleStartLoading as EventListener)
    webview.addEventListener('did-stop-loading', handleStopLoading as EventListener)
    // B2: NavBar 进度条 —— 导航完成与页面完全加载事件
    webview.addEventListener('did-finish-navigation', handleFinishNavigation as EventListener)
    webview.addEventListener('did-finish-load', handleFinishLoad as EventListener)
    // did-fail-load：UI 更新 + 代理兜底检测（先确认白屏再执行兜底）
    const PROXY_ERROR_CODES = new Set([
      -100, -102, -103, -104, -105, -107, -111, -118, -127, -130, -136, -137, -202, -300,
    ])
    let proxyFallbackTriggered = (window as any).__proxyFallbackGlobal ?? false
    const handleFailLoadWithProxy = (e: Event) => {
      const ev = e as unknown as {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
        isMainFrame?: boolean
      }
      if (ev.errorCode === -3) return // ERR_ABORTED 忽略
      handleFailLoad()
      if (ev.errorCode === -2 && ev.isMainFrame && !recoveryTimer) {
        recoveryTimer = lifecycle.delay(recoverOnce, 500)
      }
      if (
        ev.isMainFrame &&
        ev.errorCode != null &&
        PROXY_ERROR_CODES.has(ev.errorCode) &&
        !proxyFallbackTriggered
      ) {
        proxyFallbackTriggered = true
        ;(window as any).__proxyFallbackGlobal = true
        const failedUrl = ev.validatedURL || ''
        const page = lifecycle.capture()
        console.warn(
          `[proxy-fallback][BrowserView] 检测到网络错误 ${ev.errorCode}，1.5s 后检查页面...`,
        )
        lifecycle.delay(() => {
          void (webview as any)
            .executeJavaScript(
              '(function(){try{var b=document.body;if(!b)return{textLen:0,childCount:0,htmlLen:0};return{textLen:(b.innerText||"").trim().length,childCount:b.children?b.children.length:0,htmlLen:(b.innerHTML||"").length}}catch(e){return{textLen:0,childCount:0,htmlLen:0}}})()',
            )
            .then((info: { textLen: number; childCount: number; htmlLen: number }) => {
              if (!page.isCurrent()) return
              console.warn(
                `[proxy-fallback][BrowserView] textLen=${info.textLen} childCount=${info.childCount} htmlLen=${info.htmlLen}`,
              )
              if (info.textLen > 0 || info.childCount > 0 || info.htmlLen > 200) {
                console.warn('[proxy-fallback][BrowserView] 页面有内容/结构，不触发兜底')
                return
              }
              console.warn('[proxy-fallback][BrowserView] 确认白屏，执行兜底...')
              return import('../../../lib/electron-api').then((api) =>
                page.isCurrent() ? api.applyProxyFallback() : undefined,
              )
            })
            .then((result: { switched: boolean; mode: string | null } | undefined) => {
              if (!page.isCurrent()) return
              if (result?.switched) {
                console.warn(`[proxy-fallback][BrowserView] 切换到 ${result.mode}，200ms 后重载`)
                lifecycle.delay(() => {
                  try {
                    failedUrl ? (webview as any).loadURL(failedUrl) : webview.reload()
                  } catch {
                    /* ignore */
                  }
                }, 200)
              }
            })
            .catch((err: unknown) => {
              console.error('[proxy-fallback][BrowserView] 异常:', err)
            })
        }, 1500)
      }
    }
    webview.addEventListener('did-fail-load', handleFailLoadWithProxy as EventListener)

    // v0.0.9 音频事件（webview 的 media-started-playing / media-paused）
    webview.addEventListener('media-started-playing', handleMediaStartedPlaying as EventListener)
    webview.addEventListener('media-paused', handleMediaPaused as EventListener)

    webview.addEventListener('ai-webview-fatal-failure', recoverOnce)
    webview.addEventListener('render-process-gone', recoverOnce)

    // F12 → DevTools
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as { type: string; key: string; modifiers: string[] }
      if (inputEvent.type !== 'keyDown') return
      if (inputEvent.key === 'F12') {
        e.preventDefault()
        const wv = webview as unknown as {
          isDevToolsOpened: () => boolean
          openDevTools: () => void
          closeDevTools: () => void
        }
        if (wv.isDevToolsOpened()) {
          wv.closeDevTools()
        } else {
          wv.openDevTools()
        }
      }
    }
    webview.addEventListener('before-input-event', handleBeforeInput)

    return () => {
      lifecycle.dispose()
      webview.removeEventListener('dom-ready', handleDomReady as EventListener)
      webview.removeEventListener('did-navigate', handleNavigate as EventListener)
      webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener)
      webview.removeEventListener('page-title-updated', handleTitleUpdate as EventListener)
      webview.removeEventListener('page-favicon-updated', handleFaviconUpdate as EventListener)
      webview.removeEventListener('did-start-loading', handleStartLoading as EventListener)
      webview.removeEventListener('did-stop-loading', handleStopLoading as EventListener)
      webview.removeEventListener('did-finish-navigation', handleFinishNavigation as EventListener)
      webview.removeEventListener('did-finish-load', handleFinishLoad as EventListener)
      webview.removeEventListener('did-fail-load', handleFailLoadWithProxy as EventListener)
      webview.removeEventListener(
        'media-started-playing',
        handleMediaStartedPlaying as EventListener,
      )
      webview.removeEventListener('media-paused', handleMediaPaused as EventListener)
      webview.removeEventListener('ai-webview-fatal-failure', recoverOnce)
      webview.removeEventListener('render-process-gone', recoverOnce)
      webview.removeEventListener('before-input-event', handleBeforeInput)
    }
  }, [
    handleDomReady,
    handleNavigate,
    handleTitleUpdate,
    handleFaviconUpdate,
    handleStartLoading,
    handleStopLoading,
    handleFinishNavigation,
    handleFinishLoad,
    handleFailLoad,
    handleFatalFailure,
    handleMediaStartedPlaying,
    handleMediaPaused,
    tab.id,
    remountKey,
  ])

  // Register guest identity after attachment, including replacement guests.
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const register = () => {
      try {
        const wcId = webview.getWebContentsId?.()
        if (wcId === undefined) return
        const windowId = useBrowserTabStore.getState().windowId
        if (!windowId) return
        void registerWebview({
          tabId: tab.id,
          windowId,
          profileId: profile.id,
          webContentsId: wcId,
        }).catch(() => {
          /* ignore */
        })
      } catch {
        /* webview 未 attach，getWebContentsId 抛错 */
      }
    }
    // did-attach 后 webContentsId 才可用
    webview.addEventListener('did-attach', register as EventListener)
    // 兜底：dom-ready 时再注册一次（若 did-attach 已过则直接成功）
    const domReadyReg = () => register()
    webview.addEventListener('dom-ready', domReadyReg as EventListener)
    return () => {
      webview.removeEventListener('did-attach', register as EventListener)
      webview.removeEventListener('dom-ready', domReadyReg as EventListener)
    }
  }, [tab.id, profile.id, remountKey])

  // 白屏看门狗：代理瞬断或站点脚本失败时，guest 会停在纯白页面且没有任何可见错误。
  // 加载结束与切回标签时各探测一次文档结构，确认是空页则刷新；同一 URL 最多自动刷新两次，
  // 之后保留给用户手动刷新，避免与站点故障形成刷新循环。
  const blankGuardRef = useRef({ url: '', autoRetries: 0, lastReloadAt: 0, probing: false })
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const lifecycle = leaseWebviewLifecycle(webview, () => webviewRef.current)
    const guard = (source: 'load' | 'activate') => {
      const page = lifecycle.capture()
      if (!page.isCurrent()) return
      const state = blankGuardRef.current
      if (state.probing) return
      state.probing = true
      void webview
        .executeJavaScript(BLANK_PAGE_PROBE_SCRIPT)
        .then((raw) => {
          state.probing = false
          if (!page.isCurrent()) return
          const info = raw && typeof raw === 'object' ? (raw as BlankProbeResult) : null
          if (!isBlankPage(info)) {
            // 只有完成渲染且确有内容的页面才清零计数，避免加载中页面误重置
            if (info?.readyState === 'complete' || info?.readyState === 'interactive') {
              state.autoRetries = 0
            }
            return
          }
          const url = page.url || tab.url
          if (!/^https?:\/\//i.test(url)) return
          if (state.url !== url) {
            state.url = url
            state.autoRetries = 0
          }
          if (source === 'load' && state.autoRetries >= BLANK_AUTO_RETRY_LIMIT) {
            console.warn('[BrowserView] 白屏自动刷新已达上限，等待手动刷新:', url)
            return
          }
          const now = Date.now()
          if (now - state.lastReloadAt < BLANK_RELOAD_DEDUPE_MS) return
          state.autoRetries += 1
          state.lastReloadAt = now
          console.warn(
            `[BrowserView] 检测到白屏（${source === 'activate' ? '切回标签' : '加载完成'}），第 ${state.autoRetries} 次刷新: ${url}`,
          )
          safeReloadWebview(webview, url, domReadyRef.current)
        })
        .catch(() => {
          state.probing = false
        })
    }
    const onStopped = () => {
      lifecycle.delay(() => guard('load'), BLANK_PROBE_DELAY_MS)
    }
    webview.addEventListener('did-stop-loading', onStopped)
    // 切回已加载但空白的标签时没有加载事件，需要单独补一次探测
    if (active) lifecycle.delay(() => guard('activate'), BLANK_ACTIVATION_DELAY_MS)
    return () => {
      webview.removeEventListener('did-stop-loading', onStopped)
      lifecycle.dispose()
    }
  }, [active, tab.id, tab.url, remountKey])
}
