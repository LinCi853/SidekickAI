import { useEffect, useRef } from 'react';
import {
  applyProxyFallback,
  recordNavHistory,
} from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import { safeLoadURLWebview, type WebviewElement } from '../../../lib/webview';
import { useTabStore } from '../../../store/useTabStore';

type NavigationChangeCallback = (canGoBack: boolean, canGoForward: boolean) => void;
type ProcessGoneCallback = (reason: string) => void;

/**
 * webview 生命周期事件监听：长按 Tab、导航、guest 崩溃、加载失败、fatal-failure。
 * 依赖 remountKey：remount 后重新绑定到新 webview 元素。
 */
export function useWebviewLifecycleEvents({
  webviewRef,
  tab,
  profile,
  triggerRemount,
  onNavigationChangeRef,
  onProcessGoneRef,
  remountKey,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  tab: { id: string; url?: string };
  profile: Profile;
  triggerRemount: (failUrl: string, reason: string, updateTabToFailUrl: boolean) => void;
  onNavigationChangeRef: React.MutableRefObject<NavigationChangeCallback | undefined>;
  onProcessGoneRef: React.MutableRefObject<ProcessGoneCallback | undefined>;
  remountKey: number;
}) {
  const longPressTabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTabTriggeredRef = useRef(false);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    // webview 内长按 Tab 调出底栏（500ms+）。
    // 注：Alt+1~9 / Ctrl+Tab / F12 / Ctrl+G 等应用内快捷键
    // 统一由主进程 before-input-event 拦截后通过 WEBVIEW_HOTKEY IPC 转发渲染层
    // （见 MainView/index.tsx 的 onWebviewHotkey 监听），此处仅保留长按 Tab 逻辑，
    // 因主进程无法实现长按计时。
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as {
        type: string;
        key: string;
        modifiers: string[];
        isAutoRepeat: boolean;
      };
      if (inputEvent.type === 'keyDown' && inputEvent.key === 'Tab') {
        const mods = inputEvent.modifiers || [];
        const hasModifier = mods.includes('control') || mods.includes('ctrl') || mods.includes('alt') || mods.includes('meta') || mods.includes('command');
        // 无修饰键的 Tab：完全拦截，不传给网页，长按切换底栏（已展开则收起，已收起则展开）
        if (!hasModifier && !inputEvent.isAutoRepeat) {
          e.preventDefault();
          // 长按 Tab 切换底栏
          if (longPressTabTimerRef.current) {
            clearTimeout(longPressTabTimerRef.current);
          }
          longPressTabTriggeredRef.current = false;
          longPressTabTimerRef.current = setTimeout(() => {
            longPressTabTriggeredRef.current = true;
            const store = useTabStore.getState();
            // 切换底栏（已展开则收起，已收起则展开）
            store.toggleBottomBar();
          }, 500);
          return;
        }
      }
      if (inputEvent.type === 'keyUp' && inputEvent.key === 'Tab') {
        if (longPressTabTimerRef.current) {
          clearTimeout(longPressTabTimerRef.current);
          longPressTabTimerRef.current = null;
        }
        longPressTabTriggeredRef.current = false;
      }
    };
    webview.addEventListener('before-input-event', handleBeforeInput);

    // 导航事件：更新 tab.url（含 hash 变化的 in-page 导航），保证"设为AI首页"用当前URL
    const handleNavigate = (e: Event) => {
      const navEvent = e as unknown as { url?: string; type?: string };
      const newUrl = navEvent.url;
      console.log('[WebviewTab] did-navigate, type=', (e as Event).type, 'newUrl=', newUrl, 'oldTabUrl=', tab.url);
      if (newUrl && newUrl !== tab.url) {
        void useTabStore.getState().updateTabUrl(tab.id, newUrl);
        // P1-1：记录导航历史到该 Profile 的独立历史中
        void recordNavHistory(profile.id, {
          id: '',
          profileId: profile.id,
          url: newUrl,
          title: '',
          timestamp: Date.now(),
        }).catch(() => { /* ignore */ });
        // 延迟读取 title 并更新历史记录
        setTimeout(() => {
          try {
            void webview.executeJavaScript('document.title').then((title) => {
              if (title && typeof title === 'string') {
                void recordNavHistory(profile.id, {
                  id: '',
                  profileId: profile.id,
                  url: newUrl,
                  title,
                  timestamp: Date.now(),
                }).catch(() => { /* ignore */ });
              }
            }).catch(() => { /* ignore */ });
          } catch { /* ignore */ }
        }, 500);
      }
      // 导航后上报导航能力（顶栏后退/前进按钮 disabled 状态）
      try { onNavigationChangeRef.current?.(webview.canGoBack(), webview.canGoForward()); } catch { /* ignore */ }
    };
    webview.addEventListener('did-navigate', handleNavigate as EventListener);
    webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener);

    // guest 渲染进程崩溃/被杀：webview DOM 元素仍在但底层 webContents 已失效，
    // 此时 reload()/loadURL()/src 赋值全部通过 GUEST_VIEW_MANAGER_CALL IPC 异步失败。
    // 唯一可靠恢复：通过 remountKey 变化强制 React 销毁并重建 <webview> DOM 元素，
    // 让 Electron 创建全新的 guest 进程。
    const handleProcessGone = (e: Event) => {
      const ev = e as unknown as { reason?: string; exitCode?: number };
      const reason = ev.reason || 'unknown';
      console.error('[WebviewTab] guest 进程异常退出:', { tabId: tab.id, reason, exitCode: ev.exitCode });
      onProcessGoneRef.current?.(reason);
      // 崩溃 URL = 当前 tab.url（如为空则用 profile 首页）
      const failUrl = tab.url || profile.aiPlatformUrl || '';
      triggerRemount(failUrl, `render-process-gone(${reason})`, false);
    };
    webview.addEventListener('render-process-gone', handleProcessGone as EventListener);

    // 加载失败（非 200 / 网络错误）：仅记录，不中断；避免与 did-navigate 重复处理。
    // 排除 -3 (ERR_ABORTED) —— 这是导航被取消（如用户点了另一个链接），属正常现象。
    // ERR_FAILED (-2) 且 isMainFrame：guest 进程可能处于僵尸状态（未正式崩溃但无法加载），
    // 延迟 500ms 后触发 remount（给 render-process-gone 事件留出先到达的时间）
    let remountTimer: ReturnType<typeof setTimeout> | null = null;
    // 代理兜底已触发标记：全局共享，避免多个标签页重复触发同一次兜底
    // 用户手动修改代理设置时由 applyProxyToAllSessions 重置
    let proxyFallbackTriggered = (window as any).__proxyFallbackGlobal ?? false;
    // 代理/网络相关错误码（Chromium net error codes）：
    //   -100 ERR_CONNECTION_CLOSED     -102 ERR_CONNECTION_FAILED
    //   -103 ERR_CONNECTION_REFUSED    -104 ERR_CONNECTION_RESET
    //   -105 ERR_CONNECTION_ABORTED    -107 ERR_CONNECTION_ENDED
    //   -111 ERR_TUNNEL_CONNECTION_FAILED  -118 ERR_CONNECTION_TIMED_OUT
    //   -127 ERR_PROXY_AUTH_UNSUPPORTED    -130 ERR_PROXY_CONNECTION_FAILED
    //   -136 ERR_PROXY_CERTIFICATE_INVALID -137 ERR_NAME_NOT_RESOLVED
    //   -202 ERR_CERT_AUTHORITY_INVALID (代理 MITM 证书问题)
    //   -300 ERR_INVALID_URL (代理配置错误)
    const PROXY_ERROR_CODES = new Set([
      -100, -102, -103, -104, -105, -107,
      -111, -118,
      -127, -130, -136,
      -137, -202, -300,
    ]);
    const handleFailLoad = (e: Event) => {
      const ev = e as unknown as { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
      if (ev.errorCode === -3) return; // ERR_ABORTED: 导航被取消，忽略
      console.warn(`[WebviewTab] 加载失败: tabId=${tab.id} code=${ev.errorCode} desc="${ev.errorDescription}" url="${ev.validatedURL}" isMain=${ev.isMainFrame}`);
      // 代理错误码 + 主帧 + 未触发过兜底：延迟检查页面是否真的白屏
      if (
        ev.isMainFrame &&
        ev.errorCode != null &&
        PROXY_ERROR_CODES.has(ev.errorCode) &&
        !proxyFallbackTriggered
      ) {
        proxyFallbackTriggered = true;
        (window as any).__proxyFallbackGlobal = true;
        const failedUrl = ev.validatedURL || tab.url || '';
        console.warn(`[proxy-fallback] 检测到网络错误 ${ev.errorCode}，1.5s 后检查页面是否有内容...`);
        // 等待 1.5s 让页面有机会恢复（重定向、SPA 渲染等），然后检查是否白屏
        setTimeout(() => {
          void (async () => {
            try {
              // 执行 JS 检查页面是否有可见内容（文本或 DOM 子元素）
              // 某些页面（如 Claude 地区限制页）用 JS 渲染、无纯文本，需要检查 DOM 结构
              const pageInfo: { textLen: number; childCount: number; htmlLen: number } = await (webview as any).executeJavaScript(
                '(function(){try{var b=document.body;if(!b)return{textLen:0,childCount:0,htmlLen:0};return{textLen:(b.innerText||"").trim().length,childCount:b.children?b.children.length:0,htmlLen:(b.innerHTML||"").length}}catch(e){return{textLen:0,childCount:0,htmlLen:0}}})()'
              );
              console.warn(`[proxy-fallback] 页面内容检查: textLen=${pageInfo.textLen} childCount=${pageInfo.childCount} htmlLen=${pageInfo.htmlLen} url="${failedUrl}"`);
              // 有文本内容 或 有 DOM 子元素 或 HTML 长度超过最小阈值 → 页面已渲染，不是白屏
              if (pageInfo.textLen > 0 || pageInfo.childCount > 0 || pageInfo.htmlLen > 200) {
                console.warn('[proxy-fallback] 页面有内容/结构，不触发兜底（错误已恢复或非白屏）');
                return;
              }
              // 确认白屏，执行兜底
              console.warn('[proxy-fallback] 确认白屏（无可见内容），执行代理兜底...');
              const result = await applyProxyFallback();
              console.warn(`[proxy-fallback] ← switched=${result.switched} mode=${result.mode}`);
              if (result.switched) {
                console.warn(`[proxy-fallback] 200ms 后重新加载: ${failedUrl}`);
                setTimeout(() => {
                  try {
                    if (failedUrl) {
                      void safeLoadURLWebview(webview, failedUrl);
                    } else {
                      webview.reload();
                    }
                    console.warn('[proxy-fallback] reload 已触发');
                  } catch (err) {
                    console.error('[proxy-fallback] reload 失败:', err);
                  }
                }, 200);
              } else {
                console.warn('[proxy-fallback] 未切换（兜底开关关闭）');
              }
            } catch (err) {
              console.error('[proxy-fallback] 页面检查异常:', err);
            }
          })();
        }, 1500);
      } else if (ev.isMainFrame && ev.errorCode != null && PROXY_ERROR_CODES.has(ev.errorCode) && proxyFallbackTriggered) {
        console.warn(`[proxy-fallback] 已触发过，跳过: tabId=${tab.id} errorCode=${ev.errorCode}`);
      }
      // ERR_FAILED (-2) 且主帧：guest 可能已死亡，延迟触发 remount
      // （如果 render-process-gone 先到达并已触发 remount，这里的定时器会在 cleanup 中被清除）
      if (ev.errorCode === -2 && ev.isMainFrame && !remountTimer) {
        const failUrl = ev.validatedURL || tab.url || '';
        remountTimer = setTimeout(() => {
          remountTimer = null;
          triggerRemount(failUrl, 'ERR_FAILED 持续', false);
        }, 500);
      }
    };
    webview.addEventListener('did-fail-load', handleFailLoad as EventListener);

    // safeLoadURLWebview/safeReloadWebview 在 loadURL/reload 异步失败时派发此事件。
    // 这是 guest 进程死亡的可靠信号 —— src 赋值的失败不触发 did-fail-load，
    // 只有此事件能在所有恢复手段都失败后通知 WebviewTab 触发 remount。
    // 事件 detail 携带目标 URL：triggerRemount 内部根据该 URL 做防循环判定与 tab.url 更新。
    const handleFatalFailure = (e: Event) => {
      const ev = e as CustomEvent<{ url?: string }>;
      const targetUrl = ev.detail?.url || '';
      console.warn('[WebviewTab] 收到 fatal-failure 事件:', tab.id, '目标 URL:', targetUrl);
      // triggerRemount 内部会处理防循环与 tab.url 更新
      triggerRemount(targetUrl, 'fatal-failure', true);
    };
    webview.addEventListener('ai-webview-fatal-failure', handleFatalFailure as EventListener);

    return () => {
      if (remountTimer) { clearTimeout(remountTimer); remountTimer = null; }
      webview.removeEventListener('before-input-event', handleBeforeInput);
      webview.removeEventListener('did-navigate', handleNavigate as EventListener);
      webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener);
      webview.removeEventListener('render-process-gone', handleProcessGone as EventListener);
      webview.removeEventListener('did-fail-load', handleFailLoad as EventListener);
      webview.removeEventListener('ai-webview-fatal-failure', handleFatalFailure as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, tab.id, remountKey]);
}
