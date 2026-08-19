import { useEffect } from 'react';
import { onWebviewPopupUrl } from '../../../lib/electron-api';
import { safeLoadURLWebview, type WebviewElement } from '../../../lib/webview';

/**
 * 主进程转发的 webview 弹窗 URL：在当前 webview tab 内导航（页面内跳转，不弹新窗口）。
 * 多 tab 共享同一渲染进程的 IPC 通道，通过 guest webContentsId 精准匹配到触发弹窗的 webview。
 * 依赖 remountKey：remount 后需重新绑定到新 webview 元素。
 */
export function usePopupForwarding({
  webviewRef,
  tabId,
  remountKey,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  tabId: string;
  remountKey: number;
}) {
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const off = onWebviewPopupUrl(({ url, webContentsId }) => {
      let currentId: number | undefined;
      try {
        currentId = webview.getWebContentsId();
      } catch {
        // webview 未 attach 时 getWebContentsId 不可用，忽略本次事件
        return;
      }
      if (currentId !== webContentsId) return;
      console.log('[WebviewTab] 收到弹窗 URL 转发，页面内导航:', url);
      // 优先尝试 SPA 路由导航（history.pushState + popstate），避免全页 reload 导致白屏闪烁。
      // 仅对同源 URL 适用：跨域 pushState 会抛 SecurityError，需走 loadURL。
      // 失败时回退到 safeLoadURLWebview（处理 guest 崩溃后的 ERR_FAILED）。
      void (async () => {
        try {
          const currentUrl = webview.getURL?.() || '';
          let currentOrigin = '';
          let targetOrigin = '';
          try {
            currentOrigin = new URL(currentUrl).origin;
            targetOrigin = new URL(url).origin;
          } catch {
            // URL 解析失败，直接走 loadURL
          }
          if (currentOrigin && targetOrigin && currentOrigin === targetOrigin) {
            // 同源：优先 SPA 路由（pushState + popstate），避免全页 reload
            console.log('[WebviewTab] 同源弹窗 URL，尝试 SPA 路由导航:', url);
            const escapedUrl = url.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const result = await webview.executeJavaScript(`
              (function() {
                try {
                  var u = '${escapedUrl}';
                  // 仅当目标 URL 与当前 URL 不同时才导航（避免重复 pushState）
                  if (window.location.href === u) return { ok: true, skipped: true };
                  history.pushState({}, '', u);
                  // 派发 popstate 事件，通知 SPA 路由器更新 UI
                  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                  return { ok: true };
                } catch (e) {
                  return { ok: false, error: String(e) };
                }
              })()
            `) as { ok: boolean; skipped?: boolean; error?: string } | null;
            if (result && result.ok) {
              console.log('[WebviewTab] SPA 路由导航成功:', url, result.skipped ? '(已在该页面，跳过)' : '');
              return;
            }
            console.warn('[WebviewTab] SPA 路由导航失败，回退到 loadURL:', result?.error);
          }
        } catch (err) {
          console.warn('[WebviewTab] SPA 路由导航异常，回退到 loadURL:', err);
        }
        // 回退：使用 safeLoadURLWebview 处理 guest 崩溃后的 ERR_FAILED
        safeLoadURLWebview(webview, url);
      })();
    });
    return () => {
      off();
    };
  }, [tabId, remountKey]);
}
