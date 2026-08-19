/* =====================================================================
   pages/BrowserView/hooks/useWebviewNavigation.ts —— 导航相关逻辑
   抽取自 BrowserWebviewTab.tsx：外部导航、did-navigate、标题/favicon
   更新、桌面端 UA、弹窗 URL 转发、标签菜单 reload/force-reload。
   ===================================================================== */

import { useCallback, useEffect, useRef } from 'react';
import type { BrowserTabState, Profile } from '../../../lib/electron-api';
import { getPreset, onWebviewPopupUrl, recordNavHistory } from '../../../lib/electron-api';
import { safeLoadURLWebview, type WebviewElement } from '../../../lib/webview.js';
import { matchCloudPcSite } from '../cloud-pc-sites.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { AI_PLATFORMS } from '../../../../electron/presets/ai-platforms.js';
import {
  GET_TITLE_SCRIPT,
  buildFaviconToDataUrlScript,
  buildImageUrlToDataUrlScript,
} from '../webview-scripts.js';

export interface UseWebviewNavigationParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  domReadyRef: React.MutableRefObject<boolean>;
  tab: BrowserTabState;
  profile: Profile;
  /** 外部请求导航到 URL（地址栏输入） */
  navigateUrl?: string | null;
  /** 导航完成后清除 navigateUrl */
  onNavigateComplete?: () => void;
}

export function useWebviewNavigation({
  webviewRef,
  domReadyRef,
  tab,
  profile,
  navigateUrl,
  onNavigateComplete,
}: UseWebviewNavigationParams) {
  const store = useBrowserTabStore();

  // Navigate when navigateUrl changes (from address bar)
  useEffect(() => {
    if (!navigateUrl || !webviewRef.current) return;
    safeLoadURLWebview(webviewRef.current, navigateUrl);
    onNavigateComplete?.();
  }, [navigateUrl, onNavigateComplete]);

  // Navigation events
  const handleNavigate = useCallback((e: Event) => {
    const navEvent = e as unknown as { url?: string };
    const url = navEvent.url;
    if (url && url !== tab.url) {
      store.navigateTab(tab.id, url);
      // 云电脑/云游戏站点检测：通知 BrowserView 提醒开启云电脑模式
      const siteName = matchCloudPcSite(url);
      if (siteName) {
        window.dispatchEvent(new CustomEvent('cloud-pc-suggest', { detail: { url, siteName } }));
      }
      // P1-1：记录导航历史到该 Profile 的独立历史中
      console.log('[BrowserWebviewTab] 记录导航历史:', profile.id, url);
      void recordNavHistory(profile.id, {
        id: '',
        profileId: profile.id,
        url,
        title: '',
        timestamp: Date.now(),
      }).catch((err) => console.error('[BrowserWebviewTab] 记录导航历史失败:', err));
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
            void wv.executeJavaScript(GET_TITLE_SCRIPT).then((title) => {
              if (title && typeof title === 'string') {
                store.updateTabTitle(tab.id, title);
                // 更新导航历史的 title（同 URL 连续记录会更新 title 而非新增）
                if (url) {
                  void recordNavHistory(profile.id, {
                    id: '',
                    profileId: profile.id,
                    url,
                    title,
                    timestamp: Date.now(),
                  }).catch(() => { /* ignore */ });
                }
              }
            }).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      }, 500);
    }
  }, [tab.id, tab.url, tab.source, store, profile.id]);

  // Title update
  // D5: 所有标签都使用 webview 的 page-title-updated 事件返回的标题
  const handleTitleUpdate = useCallback((e: Event) => {
    // Electron webview page-title-updated 事件：title 可能在 e.title 或 e.detail.title
    const ev = e as unknown as { title?: string; detail?: { title?: string } };
    const title = ev.title || ev.detail?.title;
    if (title) {
      store.updateTabTitle(tab.id, title);
    }
  }, [tab.id, store]);

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
      void wv.executeJavaScript(buildImageUrlToDataUrlScript(`'${urlStr}'`)).then((dataUrl) => {
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

  // Listen for force-reload (clear cache) events from tab context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === tab.id && webviewRef.current) {
        (webviewRef.current as WebviewElement & { reloadIgnoringCache: () => void }).reloadIgnoringCache();
      }
    };
    window.addEventListener('browser-tab-force-reload', handler);
    return () => window.removeEventListener('browser-tab-force-reload', handler);
  }, [tab.id]);

  return {
    handleNavigate,
    handleTitleUpdate,
    handleFaviconUpdate,
  };
}
