/* =====================================================================
   pages/BrowserView/BrowserWebviewTab.tsx —— 浏览器 webview 标签
   简化版 WebviewTab：无对话抓取/登录检测，增加浏览器行为。
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserTabState, Profile } from '../../lib/electron-api';
import {
  getFingerprintScript,
  listBlockRules,
  getAppSettings,
  onWebviewPopupUrl,
  getPreset,
  recordNavHistory,
} from '../../lib/electron-api';
import { injectViewportAndPopupGuard, safeLoadURLWebview, type WebviewElement } from '../../lib/webview';
import { buildBlockerScript, matchDomain } from '../../lib/webview-blocker';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';
import { AI_PLATFORMS } from '../../../electron/presets/ai-platforms';
import { WIN_CHROME_UA } from '../../../electron/presets/devices';

interface BrowserWebviewTabProps {
  tab: BrowserTabState;
  profile: Profile;
  active: boolean;
  /** 外部请求导航到 URL（地址栏输入） */
  navigateUrl?: string | null;
  /** 导航完成后清除 navigateUrl */
  onNavigateComplete?: () => void;
}

export default function BrowserWebviewTab({
  tab,
  profile,
  active,
  navigateUrl,
  onNavigateComplete,
}: BrowserWebviewTabProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [remountKey, setRemountKey] = useState(0);
  const domReadyRef = useRef(false);
  const store = useBrowserTabStore();

  // Navigate when navigateUrl changes (from address bar)
  useEffect(() => {
    if (!navigateUrl || !webviewRef.current) return;
    safeLoadURLWebview(webviewRef.current, navigateUrl);
    onNavigateComplete?.();
  }, [navigateUrl, onNavigateComplete]);

  // dom-ready: inject fingerprint + viewport + blockers + cookie handler
  // v0.0.9: + UA 设置（基于 profile.devicePreset / uaLockMode）
  const handleDomReady = useCallback(async () => {
    const webview = webviewRef.current;
    if (!webview) return;
    domReadyRef.current = true;

    // 浏览器窗口始终使用桌面端 UA（不受 profile 移动端设置影响）
    try {
      const platform = profile.aiPlatformId
        ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
        : undefined;
      const desktopPresetId = platform?.defaultDesktopPreset ?? 'win-chrome-125';
      const preset = await getPreset(desktopPresetId);
      if (preset?.userAgent) {
        const wv = webview as unknown as { setUserAgent: (ua: string) => void };
        if (typeof wv.setUserAgent === 'function') {
          wv.setUserAgent(preset.userAgent);
        }
      }
    } catch { /* ignore UA errors */ }

    try {
      // Fingerprint
      const script = await getFingerprintScript(profile.id);
      await webview.executeJavaScript(script);

      // Viewport + popup guard
      await injectViewportAndPopupGuard(webview);

      // Block rules
      try {
        const settings = await getAppSettings();
        if (!settings.disableAllBlockRules) {
          const rules = await listBlockRules();
          const url = webview.getURL();
          const hostname = url ? new URL(url).hostname : '';
          if (hostname) {
            const matched = rules.filter((r) => r.enabled && matchDomain(r.domainPattern, hostname));
            if (matched.length > 0) {
              await webview.executeJavaScript(buildBlockerScript(matched));
            }
          }
        }
      } catch { /* ignore */ }
    } catch (e) {
      console.error('[BrowserWebviewTab] dom-ready injection failed:', e);
    }

    // 兜底：dom-ready 后主动读取初始 title 和 favicon
    if (tab.source !== 'initial') {
      try {
        const title = await webview.executeJavaScript('document.title');
        if (title && typeof title === 'string') {
          store.updateTabTitle(tab.id, title);
        }
      } catch { /* ignore */ }
      try {
        // 在 webview 内部将 favicon 转换为 data URL（base64），解决跨域/协议限制
        const faviconDataUrl = await webview.executeJavaScript(`
          (function() {
            return new Promise(function(resolve) {
              var links = document.querySelectorAll('link[rel*="icon"]');
              var href = '';
              for (var i = 0; i < links.length; i++) {
                href = links[i].getAttribute('href');
                if (href) break;
              }
              if (!href) { resolve(''); return; }
              try { href = new URL(href, document.baseURI).href; } catch(e) {}
              var img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = function() {
                try {
                  var canvas = document.createElement('canvas');
                  canvas.width = img.naturalWidth || 32;
                  canvas.height = img.naturalHeight || 32;
                  var ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                  resolve(canvas.toDataURL('image/png'));
                } catch(e) { resolve(href); }
              };
              img.onerror = function() { resolve(''); };
              img.src = href;
            });
          })()
        `);
        if (faviconDataUrl && typeof faviconDataUrl === 'string' && faviconDataUrl.length > 10) {
          store.updateTabFavicon(tab.id, faviconDataUrl);
        }
      } catch { /* ignore */ }
    }
  }, [profile.id, profile.devicePreset, profile.userAgent, tab.id, tab.source, store]);

  // Navigation events
  const handleNavigate = useCallback((e: Event) => {
    const navEvent = e as unknown as { url?: string };
    const url = navEvent.url;
    if (url && url !== tab.url) {
      store.navigateTab(tab.id, url);
    }
    try {
      const wv = webviewRef.current;
      if (wv) store.updateTabNavState(tab.id, wv.canGoBack(), wv.canGoForward());
    } catch { /* ignore */ }

    // 导航后延迟读取 title（部分页面 title 在 did-navigate 后才设置）
    if (tab.source !== 'initial') {
      setTimeout(() => {
        try {
          const wv = webviewRef.current;
          if (wv) {
            void wv.executeJavaScript('document.title').then((title) => {
              if (title && typeof title === 'string') {
                store.updateTabTitle(tab.id, title);
              }
            }).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      }, 500);
    }
  }, [tab.id, tab.url, tab.source, store]);

  // Title update
  // v0.0.9: 主页标签（从主窗口脱离的）保持用户编辑的名称，不随网页标题变化；
  // 新开的网页标签显示网页标题
  const handleTitleUpdate = useCallback((e: Event) => {
    if (tab.source === 'initial') return; // 主页标签保持 profile.name
    // Electron webview page-title-updated 事件：title 可能在 e.title 或 e.detail.title
    const ev = e as unknown as { title?: string; detail?: { title?: string } };
    const title = ev.title || ev.detail?.title;
    if (title) {
      store.updateTabTitle(tab.id, title);
    }
  }, [tab.id, tab.source, store]);

  // Favicon update - 将 favicon URL 转换为 data URL 以确保渲染进程可加载
  const handleFaviconUpdate = useCallback((e: Event) => {
    const ev = e as unknown as { favicons?: string[]; detail?: { favicons?: string[] } };
    const favicons = ev.favicons || ev.detail?.favicons;
    const faviconUrl = favicons?.[0];
    if (!faviconUrl) return;
    // 如果已经是 data URL，直接使用
    if (faviconUrl.startsWith('data:')) {
      store.updateTabFavicon(tab.id, faviconUrl);
      return;
    }
    // 尝试在 webview 内部转换为 data URL
    const wv = webviewRef.current;
    if (wv && domReadyRef.current) {
      const urlStr = faviconUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      void wv.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function() {
              try {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || 32;
                canvas.height = img.naturalHeight || 32;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
              } catch(e) { resolve(''); }
            };
            img.onerror = function() { resolve(''); };
            img.src = '${urlStr}';
          });
        })()
      `).then((dataUrl) => {
        if (dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
          store.updateTabFavicon(tab.id, dataUrl);
        } else {
          // 转换失败，仍然使用原始 URL（可能在某些情况下可以加载）
          store.updateTabFavicon(tab.id, faviconUrl);
        }
      }).catch(() => {
        store.updateTabFavicon(tab.id, faviconUrl);
      });
    } else {
      store.updateTabFavicon(tab.id, faviconUrl);
    }
  }, [tab.id, store]);

  // Loading state
  const handleStartLoading = useCallback(() => {
    store.updateTabLoading(tab.id, true);
  }, [tab.id, store]);

  const handleStopLoading = useCallback(() => {
    store.updateTabLoading(tab.id, false);

    // 兜底：页面加载完成后主动读取 title 和 favicon
    // 解决 page-title-updated / page-favicon-updated 事件可能不触发的问题
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) return;
    try {
      // 读取 document.title
      void webview.executeJavaScript('document.title').then((title) => {
        if (title && typeof title === 'string' && tab.source !== 'initial') {
          store.updateTabTitle(tab.id, title);
        }
      }).catch(() => { /* ignore */ });

      // 读取 favicon 并转换为 data URL
      void webview.executeJavaScript(`
        (function() {
          return new Promise(function(resolve) {
            var links = document.querySelectorAll('link[rel*="icon"]');
            var href = '';
            for (var i = 0; i < links.length; i++) {
              href = links[i].getAttribute('href');
              if (href) break;
            }
            if (!href) { resolve(''); return; }
            try { href = new URL(href, document.baseURI).href; } catch(e) {}
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function() {
              try {
                var canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || 32;
                canvas.height = img.naturalHeight || 32;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
              } catch(e) { resolve(href); }
            };
            img.onerror = function() { resolve(''); };
            img.src = href;
          });
        })()
      `).then((favicon) => {
        if (favicon && typeof favicon === 'string' && favicon.length > 10) {
          store.updateTabFavicon(tab.id, favicon);
        }
      }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }, [tab.id, tab.source, store]);

  // Remount on fatal failure
  const handleFatalFailure = useCallback(() => {
    console.warn('[BrowserWebviewTab] fatal failure, remounting:', tab.url);
    domReadyRef.current = false;
    setRemountKey((k) => k + 1);
  }, [tab.url]);

  // ===== v0.0.9 音频集成 =====
  // 页面开始播放音频 → 更新 audible 状态
  const handleMediaStartedPlaying = useCallback(() => {
    store.updateAudible(tab.id, true);
  }, [tab.id, store]);

  // 页面停止播放音频 → 更新 audible 状态
  const handleMediaPaused = useCallback(() => {
    store.updateAudible(tab.id, false);
  }, [tab.id, store]);

  // 应用静音状态到 webview（muted 变化或 remount 后重新应用）
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    try {
      const wv = webview as unknown as { setAudioMuted: (muted: boolean) => void };
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(!!tab.muted);
      }
    } catch { /* ignore */ }
  }, [tab.muted, tab.id, remountKey]);

  // 站点权限 - 强制静音（sitePermissions.mute 优先于用户 muted）
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const shouldMute = tab.muted || !!tab.sitePermissions?.mute;
    try {
      const wv = webview as unknown as { setAudioMuted: (muted: boolean) => void };
      if (typeof wv.setAudioMuted === 'function') {
        wv.setAudioMuted(shouldMute);
      }
    } catch { /* ignore */ }
  }, [tab.muted, tab.sitePermissions?.mute, tab.id, remountKey]);

  // Register event listeners
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    webview.addEventListener('dom-ready', handleDomReady as EventListener);
    webview.addEventListener('did-navigate', handleNavigate as EventListener);
    webview.addEventListener('did-navigate-in-page', handleNavigate as EventListener);
    webview.addEventListener('page-title-updated', handleTitleUpdate as EventListener);
    webview.addEventListener('page-favicon-updated', handleFaviconUpdate as EventListener);
    webview.addEventListener('did-start-loading', handleStartLoading as EventListener);
    webview.addEventListener('did-stop-loading', handleStopLoading as EventListener);

    // v0.0.9 音频事件（webview 的 media-started-playing / media-paused）
    webview.addEventListener('media-started-playing', handleMediaStartedPlaying as EventListener);
    webview.addEventListener('media-paused', handleMediaPaused as EventListener);

    webview.addEventListener('ai-webview-fatal-failure', handleFatalFailure);

    // F12 → DevTools
    const handleBeforeInput = (e: Event) => {
      const inputEvent = e as unknown as { type: string; key: string; modifiers: string[] };
      if (inputEvent.type !== 'keyDown') return;
      if (inputEvent.key === 'F12') {
        e.preventDefault();
        const wv = webview as unknown as {
          isDevToolsOpened: () => boolean;
          openDevTools: () => void;
          closeDevTools: () => void;
        };
        if (wv.isDevToolsOpened()) {
          wv.closeDevTools();
        } else {
          wv.openDevTools();
        }
      }
    };
    webview.addEventListener('before-input-event', handleBeforeInput);

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady as EventListener);
      webview.removeEventListener('did-navigate', handleNavigate as EventListener);
      webview.removeEventListener('did-navigate-in-page', handleNavigate as EventListener);
      webview.removeEventListener('page-title-updated', handleTitleUpdate as EventListener);
      webview.removeEventListener('page-favicon-updated', handleFaviconUpdate as EventListener);
      webview.removeEventListener('did-start-loading', handleStartLoading as EventListener);
      webview.removeEventListener('did-stop-loading', handleStopLoading as EventListener);
      webview.removeEventListener('media-started-playing', handleMediaStartedPlaying as EventListener);
      webview.removeEventListener('media-paused', handleMediaPaused as EventListener);
      webview.removeEventListener('ai-webview-fatal-failure', handleFatalFailure);
      webview.removeEventListener('before-input-event', handleBeforeInput);
    };
  }, [handleDomReady, handleNavigate, handleTitleUpdate, handleFaviconUpdate, handleStartLoading, handleStopLoading, handleFatalFailure, handleMediaStartedPlaying, handleMediaPaused]);

  // 浏览器窗口始终锁定为桌面端 UA（不受 profile 的 uaLockMode 影响）
  const prevUaRef = useRef<string>('');
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    // 浏览器窗口始终使用桌面端 UA
    const platform = profile.aiPlatformId
      ? AI_PLATFORMS.find((p) => p.id === profile.aiPlatformId)
      : undefined;
    const desktopPresetId = platform?.defaultDesktopPreset ?? 'win-chrome-125';
    if (prevUaRef.current === desktopPresetId) return;
    prevUaRef.current = desktopPresetId;
    void getPreset(desktopPresetId).then((preset) => {
      if (!preset?.userAgent || !webviewRef.current) return;
      try {
        const wv = webviewRef.current as unknown as { setUserAgent: (ua: string) => void };
        if (typeof wv.setUserAgent === 'function') {
          wv.setUserAgent(preset.userAgent);
          if (domReadyRef.current) {
            webviewRef.current.reload();
          }
        }
      } catch { /* ignore */ }
    });
  }, [profile.aiPlatformId]);

  // Listen for popup URL forwarding from main process
  useEffect(() => {
    const off = onWebviewPopupUrl((payload) => {
      if (payload.webContentsId === webviewRef.current?.getWebContentsId?.()) {
        safeLoadURLWebview(webviewRef.current!, payload.url);
      }
    });
    return off;
  }, []);

  // Listen for reload events from tab context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tab.id && webviewRef.current) {
        webviewRef.current.reload();
      }
    };
    window.addEventListener('browser-tab-reload', handler);
    return () => window.removeEventListener('browser-tab-reload', handler);
  }, [tab.id]);

  // 使用与主窗口相同的 partition，保留全部登录态和页面数据
  const partition = `persist:${profile.id}`;
  // v0.0.9: 初始 UA 优先用 profile.devicePreset 的 UA，避免首次加载用错误 UA
  // dom-ready 后会通过 setUserAgent 再次精确设置
  // 浏览器窗口始终使用桌面端 UA，不受 profile 移动端设置影响
  const initialUa = WIN_CHROME_UA;

  return (
    <webview
      ref={webviewRef as React.RefObject<HTMLElement> as React.RefObject<WebviewElement>}
      key={`${tab.id}-${remountKey}`}
      src={tab.url || profile.aiPlatformUrl || ''}
      partition={partition}
      useragent={initialUa}
      {...({ allowpopups: 'true' } as Record<string, unknown>)}
      data-tab-id={tab.id}
      data-name="browser.webview-tab"
      style={{
        display: 'flex',
        visibility: active ? 'visible' : 'hidden',
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 'none',
      }}
    />
  );
}

