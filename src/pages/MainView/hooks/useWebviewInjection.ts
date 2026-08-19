import { useEffect } from 'react';
import {
  getFingerprintScript,
  logLoginTrace,
} from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import { injectViewportAndPopupGuard, type WebviewElement } from '../../../lib/webview';
import { injectionManager } from '../../../lib/injection-manager';
import { DETECT_LOGIN_SCRIPT, buildEnterToSendScript } from '../scripts';

type DomReadyChangeCallback = (isReady: boolean) => void;
type NavigationChangeCallback = (canGoBack: boolean, canGoForward: boolean) => void;

/**
 * dom-ready 注入流程：指纹脚本 / viewport / 统一注入管理器 / 登录痕迹检测 / Enter 发送。
 * 通过共享 webview ref 与 domReadyRef 保证注入时序与 ref 生命周期一致。
 */
export function useWebviewInjection({
  webviewRef,
  tab,
  profile,
  inputSelector,
  sendSelector,
  enterToSendRef,
  domReadyRef,
  onDomReadyChangeRef,
  onNavigationChangeRef,
  resetRemountFailState,
  loggedLoginUrlsRef,
  lastLoginCheckedUrlRef,
  remountKey,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  tab: { id: string };
  profile: Profile;
  inputSelector?: string | null;
  sendSelector?: string | null;
  enterToSendRef: React.MutableRefObject<boolean>;
  domReadyRef: React.MutableRefObject<boolean>;
  onDomReadyChangeRef: React.MutableRefObject<DomReadyChangeCallback | undefined>;
  onNavigationChangeRef: React.MutableRefObject<NavigationChangeCallback | undefined>;
  resetRemountFailState: () => void;
  loggedLoginUrlsRef: React.MutableRefObject<Set<string>>;
  lastLoginCheckedUrlRef: React.MutableRefObject<string>;
  remountKey: number;
}) {
  // dom-ready：注入指纹脚本
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let cancelled = false;
    const handleDomReady = async () => {
      domReadyRef.current = true;
      console.log('[WebviewTab] dom-ready, url=', webview.getURL(), 'profileId=', profile.id);
      // 页面成功加载：重置 remount 防循环计数器
      // （下次失败时若 URL 不同则正常重试，避免误判为连续失败循环）
      resetRemountFailState();
      // 上报 dom-ready 状态变化（供父组件判断 reload/loadURL 是否安全）
      onDomReadyChangeRef.current?.(true);
      // 上报初始导航能力（供顶栏后退/前进按钮 disabled 状态）
      try { onNavigationChangeRef.current?.(webview.canGoBack(), webview.canGoForward()); } catch { /* ignore */ }
      try {
        // 1. 注入指纹脚本
        const script = await getFingerprintScript(profile.id);
        await webview.executeJavaScript(script);

        // 2. 强制移动端 viewport，防止部分网页因 viewport 宽度计算错误出现横向滚动/阴影
        await injectViewportAndPopupGuard(webview, { injectShadowStyle: true });

        // 3. 通过统一注入管理器注入可关闭功能（屏蔽规则、Cookie 处理、空间导航）
        //    注入管理器内部检查功能开关，自动跳过已关闭的功能
        try {
          await injectionManager.injectAll(
            tab.id,
            webview,
            webview.getURL(),
          );
        } catch (e) {
          console.error('[WebviewTab] 统一注入失败:', e);
        }

        // 5. 登录痕迹检测：仅对 AI 平台 Profile 生效。dom-ready 在每次导航后触发，
        //    覆盖页面间 URL 变化；等待 3 秒让登录后元素（头像/菜单）渲染完成，
        //    再执行检测脚本，若已登录且该 URL 未记录过，则记录一次登录痕迹。
        if (profile.isAIPlatform) {
          setTimeout(async () => {
            if (cancelled) return;
            try {
              const ret = await webview.executeJavaScript(DETECT_LOGIN_SCRIPT);
              if (cancelled) return;
              const parsed = JSON.parse(String(ret)) as {
                url?: string;
                cookie?: string;
                isLoggedIn?: boolean;
                error?: string;
              };
              if (parsed.error) return;
              const loginUrl = parsed.url || '';
              if (!parsed.isLoggedIn || !loginUrl) return;
              if (loggedLoginUrlsRef.current.has(loginUrl)) return;
              loggedLoginUrlsRef.current.add(loginUrl);
              lastLoginCheckedUrlRef.current = loginUrl;
              await logLoginTrace({
                profileId: profile.id,
                platform: profile.aiPlatformId,
                loginUrl,
                sessionData: parsed.cookie,
              });
            } catch (e) {
              console.error('[WebviewTab] 登录痕迹检测失败:', e);
            }
          }, 3000);
        }

        // 5.6 空间导航已在步骤 3 通过注入管理器统一注入

        // 6. 注入 Enter 发送 / Shift+Enter 换行行为
        //    始终注入监听器，通过运行时标志 window.__ai_enter_send_enabled__ 控制开关
        //    这样设置面板切换 enterToSend 时无需重新注入，只需更新标志位
        try {
          await webview.executeJavaScript(buildEnterToSendScript({
            enabled: enterToSendRef.current,
            inputSelector,
            sendSelector,
          }));
        } catch (e) {
          console.error('[WebviewTab] Enter 发送行为注入失败:', e);
        }
      } catch (e) {
        console.error('[WebviewTab] dom-ready 注入失败:', e);
      }
    };
    webview.addEventListener('dom-ready', handleDomReady as EventListener);

    return () => {
      cancelled = true;
      domReadyRef.current = false;
      webview.removeEventListener('dom-ready', handleDomReady as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.isAIPlatform, profile.aiPlatformId, tab.id, inputSelector, sendSelector, remountKey]);
}
