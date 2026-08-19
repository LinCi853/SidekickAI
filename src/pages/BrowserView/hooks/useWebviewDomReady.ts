/* =====================================================================
   pages/BrowserView/hooks/useWebviewDomReady.ts —— dom-ready 注入管线
   抽取自 BrowserWebviewTab.tsx：fingerprint + viewport + blockers + UA
   + 初始 title/favicon/主题色兜底 + 云电脑缩放 + 文件拖放/右键坐标桥。
   ===================================================================== */

import { useCallback } from 'react';
import type { BrowserTabState, Profile } from '../../../lib/electron-api';
import { getFingerprintScript, getPreset } from '../../../lib/electron-api';
import { injectViewportAndPopupGuard, type WebviewElement } from '../../../lib/webview.js';
import { injectionManager } from '../../../lib/injection-manager.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { useCloudPcStore } from '../../../store/useCloudPcStore.js';
import { useGamepadStore } from '../../../store/useGamepadStore.js';
import { buildSpatialNavScript } from '../../../lib/webview-spatial-nav.js';
import { AI_PLATFORMS } from '../../../../electron/presets/ai-platforms.js';
import { extractThemeColor } from '../utils/favicon-placeholder.js';
import {
  GET_TITLE_SCRIPT,
  SPATIAL_NAV_ENABLE_SCRIPT,
  buildFaviconToDataUrlScript,
  FILE_DROP_BRIDGE_SCRIPT,
  CONTEXT_COORD_HOOK_SCRIPT,
} from '../webview-scripts.js';

export interface UseWebviewDomReadyParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  domReadyRef: React.MutableRefObject<boolean>;
  tab: BrowserTabState;
  profile: Profile;
}

/** dom-ready：注入 fingerprint + viewport + blockers + cookie handler；
 * v0.0.9：+ UA 设置（基于 profile.aiPlatformId 的桌面端预设）。 */
export function useWebviewDomReady({ webviewRef, domReadyRef, tab, profile }: UseWebviewDomReadyParams) {
  const store = useBrowserTabStore();

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
      // Fingerprint：云电脑模式下跳过——伪造的 screen 尺寸/DPR 会破坏
      // 远端对真实分辨率与窗口大小的识别（云电脑页面需要真实设备信息）
      if (!useCloudPcStore.getState().isActive) {
        const script = await getFingerprintScript(profile.id);
        await webview.executeJavaScript(script);
      }

      // Viewport + popup guard
      await injectViewportAndPopupGuard(webview);

      // 手柄/键盘空间导航注入（等效主窗口 Ctrl+G）
      // 云电脑模式 + 手柄已接入时自动开启，方便直接用手柄操作网页内容
      try {
        await webview.executeJavaScript(buildSpatialNavScript());
        const autoEnable =
          useCloudPcStore.getState().isActive &&
          useGamepadStore.getState().connectedCount > 0;
        if (autoEnable) {
          await webview.executeJavaScript(SPATIAL_NAV_ENABLE_SCRIPT);
        }
      } catch (e) {
        console.error('[BrowserWebviewTab] 空间导航注入失败:', e);
      }

      // 通过统一注入管理器注入可关闭功能（屏蔽规则、空间导航）
      try {
        await injectionManager.injectAll(
          `browser-${tab.id}`,
          webview,
          webview.getURL(),
        );
      } catch { /* ignore */ }
    } catch (e) {
      console.error('[BrowserWebviewTab] dom-ready injection failed:', e);
    }

    // 兜底：dom-ready 后主动读取初始 title 和 favicon
    if (tab.source !== 'initial') {
      try {
        const title = await webview.executeJavaScript(GET_TITLE_SCRIPT);
        if (title && typeof title === 'string') {
          store.updateTabTitle(tab.id, title);
        }
      } catch { /* ignore */ }
      try {
        // 在 webview 内部将 favicon 转换为 data URL（base64），解决跨域/协议限制
        const faviconDataUrl = await webview.executeJavaScript(buildFaviconToDataUrlScript());
        if (faviconDataUrl && typeof faviconDataUrl === 'string' && faviconDataUrl.length > 10) {
          store.updateTabFavicon(tab.id, faviconDataUrl);
        }
      } catch { /* ignore */ }
      // P1-5：提取网站主题色（meta[name="theme-color"]），用于 favicon 占位背景
      try {
        const color = await extractThemeColor(webview);
        if (color) {
          store.updateTabThemeColor(tab.id, color);
        }
      } catch { /* ignore */ }
    }

    // 云电脑模式：dom-ready 后应用缩放因子（4K 屏跑 1080P 云电脑铺满屏幕；
    // 新 webview / reload 后都需要重新设置，缩放状态下页面 CSS 视口匹配远端分辨率，
    // 媒体查询按桌面布局判断，避免误切移动端模式）
    const cloudPcState = useCloudPcStore.getState();
    if (cloudPcState.isActive && cloudPcState.zoomFactor !== 1) {
      try {
        (webview as WebviewElement & { setZoomFactor: (f: number) => void }).setZoomFactor(cloudPcState.zoomFactor);
      } catch { /* ignore */ }
    }

    // 注入本地文件拖放桥：拖文件到页面时，若页面自身没有处理（无上传区），
    // 通过 console-message 上报文件路径（Electron File.path），由宿主打开查看；
    // 页面已处理（preventDefault）则不干预，保留网页上传能力。
    try {
      await webview.executeJavaScript(FILE_DROP_BRIDGE_SCRIPT);
    } catch { /* ignore */ }

    // 注入右键坐标记录脚本：guest 的 contextmenu DOM 事件提供精确的
    // clientX/clientY（viewport CSS 坐标），供右键菜单定位、聚焦输入框、
    // 检查元素使用（比 Electron 转发的 params 坐标更可靠）。
    try {
      await webview.executeJavaScript(CONTEXT_COORD_HOOK_SCRIPT);
    } catch { /* ignore */ }
  }, [profile.id, profile.devicePreset, profile.userAgent, tab.id, tab.source, store]);

  return handleDomReady;
}
