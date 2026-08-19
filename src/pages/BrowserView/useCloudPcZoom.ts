/* =====================================================================
   pages/BrowserView/useCloudPcZoom.ts —— 云电脑内容缩放管理
   解决 4K 屏跑 1080P 云电脑时的两个问题：
   - 页面按 4K 全屏布局（CSS 视口 3840px），1080P 视频流只占中央一小块
   - 超大视口/伪造指纹导致页面自适应切到移动端布局
   方案（云电脑客户端标准做法）：把 webview 内容缩放到与远端分辨率匹配——
   setZoomFactor 后页面 CSS 视口 = 远端分辨率（如 1920×1080），视频铺满屏幕，
   媒体查询按桌面 1920 布局，不再误判移动端。
   自动模式：每 2s 检测页面中最大的 video 原生分辨率（含同源 iframe），
   计算缩放因子 = min(窗口宽/远端宽, 窗口高/远端高)（clamp 0.5~4）。
   检测不到视频时保持手动因子（默认 1）。
   ===================================================================== */

import { useCallback, useEffect, useRef } from 'react';
import type { WebviewElement } from '../../lib/webview';
import { useCloudPcStore } from '../../store/useCloudPcStore';

export function useCloudPcZoom(
  webviewContainerRef: React.MutableRefObject<HTMLDivElement | null>,
  activeTabId: string | null,
) {
  const isActive = useCloudPcStore((s) => s.isActive);
  const zoomMode = useCloudPcStore((s) => s.zoomMode);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const getWebview = useCallback((): (WebviewElement & { setZoomFactor: (f: number) => void }) | null => {
    const id = activeTabIdRef.current;
    if (!id) return null;
    const selector = 'webview[data-tab-id="' + String(id) + '"]';
    return webviewContainerRef.current?.querySelector(selector) as (WebviewElement & { setZoomFactor: (f: number) => void }) | null;
  }, [webviewContainerRef]);

  /** 应用缩放因子到当前 webview 并写入 store */
  const applyZoom = useCallback((factor: number, mode?: 'auto' | 'manual') => {
    const clamped = Math.max(0.5, Math.min(4, factor));
    const webview = getWebview();
    if (webview) {
      try { webview.setZoomFactor(clamped); } catch { /* ignore */ }
    }
    useCloudPcStore.getState().setZoom(clamped, mode);
  }, [getWebview]);

  /** 检测页面中最大视频的远端原生分辨率，并自动匹配缩放 */
  const detectRemoteResolution = useCallback(async () => {
    if (useCloudPcStore.getState().zoomMode !== 'auto') return;
    const webview = getWebview();
    if (!webview) return;
    try {
      const script = [
        "(function() {",
        "  var best = null;",
        "  function scan(doc, depth) {",
        "    if (!doc || depth > 3) return;",
        "    var videos = doc.querySelectorAll('video');",
        "    for (var i = 0; i < videos.length; i++) {",
        "      var v = videos[i];",
        "      var w = v.videoWidth, h = v.videoHeight;",
        "      if (!w || !h) continue;",
        "      var area = w * h;",
        "      if (!best || area > best.w * best.h) best = { w: w, h: h };",
        "    }",
        "    var frames = doc.querySelectorAll('iframe');",
        "    for (var j = 0; j < frames.length; j++) {",
        "      try { scan(frames[j].contentDocument, depth + 1); } catch (e) { }",
        "    }",
        "  }",
        "  scan(document, 0);",
        "  return best;",
        "})()",
      ].join('\n');
      const result = await webview.executeJavaScript(script) as { w: number; h: number } | null;
      if (result && result.w > 0 && result.h > 0) {
        useCloudPcStore.getState().setRemoteResolution({ width: result.w, height: result.h });
        // 缩放因子 = 窗口尺寸 / 远端分辨率（取较小值保证完整显示）
        const factor = Math.min(window.innerWidth / result.w, window.innerHeight / result.h);
        const clamped = Math.max(0.5, Math.min(4, factor));
        const current = useCloudPcStore.getState().zoomFactor;
        // 变化超过 5% 才重新应用，避免抖动
        if (Math.abs(clamped - current) > 0.05) {
          console.log('[cloud-pc] 检测到远端分辨率', result, '→ 缩放', clamped.toFixed(2));
          applyZoom(clamped, 'auto');
        }
      }
    } catch { /* 页面尚未就绪/跨域限制时忽略 */ }
  }, [getWebview, applyZoom]);

  // 云电脑模式激活且自动模式：立即检测 + 每 2s 轮询（支持远端动态切换分辨率）
  useEffect(() => {
    if (!isActive || zoomMode !== 'auto') return;
    void detectRemoteResolution();
    const timer = setInterval(() => void detectRemoteResolution(), 2000);
    return () => clearInterval(timer);
  }, [isActive, zoomMode, detectRemoteResolution]);

  // 激活/切换标签：重新应用当前缩放因子（新 webview 需要重新设置）
  useEffect(() => {
    if (!isActive) return;
    const factor = useCloudPcStore.getState().zoomFactor;
    if (factor !== 1) {
      const webview = getWebview();
      if (webview) {
        try { webview.setZoomFactor(factor); } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, activeTabId]);

  // 退出云电脑模式：重置缩放为 1
  useEffect(() => {
    if (isActive) return;
    const webview = getWebview();
    if (webview) {
      try { webview.setZoomFactor(1); } catch { /* ignore */ }
    }
    const s = useCloudPcStore.getState();
    if (s.zoomFactor !== 1 || s.remoteResolution !== null) {
      s.setZoom(1, 'auto');
      s.setRemoteResolution(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  return { applyZoom, detectRemoteResolution };
}
