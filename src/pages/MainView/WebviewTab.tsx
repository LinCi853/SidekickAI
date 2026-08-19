// 维护性说明：本文件已完成拆分。
// dom-ready 注入 → useWebviewInjection；事件监听 → useWebviewLifecycleEvents；
// 弹窗转发 → usePopupForwarding；弹窗白名单 → usePopupWhitelist；
// Enter 发送标志 → useEnterToSendFlag；remount/UA/抓取 → useWebviewRemount/useWebviewUa/useConversationScrape。
import { useEffect, useMemo, useRef } from 'react';
import { sanitizeUrl, type WebviewElement } from '../../lib/webview';
import type { Profile } from '../../lib/electron-api';
import { useWebviewRemount } from './hooks/useWebviewRemount';
import { useWebviewUa } from './hooks/useWebviewUa';
import { useConversationScrape } from './hooks/useConversationScrape';
import { useWebviewInjection } from './hooks/useWebviewInjection';
import { useWebviewLifecycleEvents } from './hooks/useWebviewLifecycleEvents';
import { usePopupForwarding } from './hooks/usePopupForwarding';
import { usePopupWhitelist } from './hooks/usePopupWhitelist';
import { useEnterToSendFlag } from './hooks/useEnterToSendFlag';

/* =====================================================================
   WebviewTab —— 单个标签的 webview（自管理指纹注入与导航）
   所有标签的 webview 始终挂载，仅通过 display 切换可见性，保留页面状态。
   具体职责已拆分至 src/pages/MainView/hooks/ 下的独立 hook。
   ===================================================================== */

export function WebviewTab({
  tab,
  profile,
  active,
  isNarrow,
  desktopPresetId,
  mobilePresetId,
  inputSelector,
  sendSelector,
  enterToSend,
  onNavigationChange,
  onDomReadyChange,
  onProcessGone,
}: {
  tab: { id: string; profileId: string; url?: string; title?: string; autoMobile?: boolean; originalDevicePreset?: string };
  profile: Profile;
  active: boolean;
  isNarrow: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
  inputSelector?: string | null;
  sendSelector?: string | null;
  enterToSend?: boolean;
  /** webview 导航能力变化回调（dom-ready / 导航后上报 canGoBack/canGoForward） */
  onNavigationChange?: (canGoBack: boolean, canGoForward: boolean) => void;
  /** webview dom-ready 状态变化回调（供父组件判断 reload/loadURL 是否安全） */
  onDomReadyChange?: (isReady: boolean) => void;
  /** webview guest 进程崩溃/异常退出回调（供父组件触发恢复或提示用户） */
  onProcessGone?: (reason: string) => void;
}) {
  const ref = useRef<WebviewElement | null>(null);

  // 导航能力回调 ref（避免 webview setup effect 依赖 onNavigationChange 导致重复挂载）
  const onNavigationChangeRef = useRef(onNavigationChange);
  useEffect(() => { onNavigationChangeRef.current = onNavigationChange; });
  // 进程崩溃回调 ref（同上，避免重复挂载）
  const onProcessGoneRef = useRef(onProcessGone);
  useEffect(() => { onProcessGoneRef.current = onProcessGone; });

  // remount 计数器 / dom-ready 状态 / 延缓 reload：统一由此 hook 管理
  const {
    remountKey,
    domReadyRef,
    onDomReadyChangeRef,
    triggerRemount,
    resetRemountFailState,
    scheduleReload,
  } = useWebviewRemount({ tab, profile, onDomReadyChange });

  // enterToSend 运行时标志（供 dom-ready 闭包读取）+ webview 标志位更新
  const { enterToSendRef } = useEnterToSendFlag({
    webviewRef: ref,
    domReadyRef,
    enterToSend,
  });

  // 登录痕迹：已记录过登录的 URL 集合、上次检测登录的 URL（注入与抓取共用）
  const loggedLoginUrlsRef = useRef<Set<string>>(new Set());
  const lastLoginCheckedUrlRef = useRef<string>('');

  // dom-ready：注入指纹 / viewport / 统一注入 / 登录检测 / Enter 发送
  useWebviewInjection({
    webviewRef: ref,
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
  });

  // 导航 / 崩溃 / 加载失败 / 长按 Tab / fatal-failure 事件监听
  useWebviewLifecycleEvents({
    webviewRef: ref,
    tab,
    profile,
    triggerRemount,
    onNavigationChangeRef,
    onProcessGoneRef,
    remountKey,
  });

  // profile UA / 设备预设变化时刷新 webview
  useWebviewUa({
    webviewRef: ref,
    profile,
    isNarrow,
    desktopPresetId,
    mobilePresetId,
    domReadyRef,
    scheduleReload,
  });

  // 主进程转发的 webview 弹窗 URL：页面内导航
  usePopupForwarding({ webviewRef: ref, tabId: tab.id, remountKey });

  // 弹窗白名单确认
  usePopupWhitelist({ profileId: tab.profileId });

  // 定期抓取网页对话内容并持久化到 SQLite（仅 AI 平台 Profile）
  useConversationScrape({
    webviewRef: ref,
    profile,
    tab,
    remountKey,
    domReadyRef,
    loggedLoginUrlsRef,
    lastLoginCheckedUrlRef,
  });

  // webview 的 src 仅在挂载时设置一次（基于 tab.id / remountKey），
  // 不随 tab.url 变化重写。否则 SPA 内部 in-page 导航触发 updateTabUrl →
  // React 重渲染 → <webview src={新URL}> → Electron 内部 loadURL(新URL) →
  // 与 SPA 当前导航冲突产生 ERR_ABORTED，并可能干扰 SPA 路由导致页面跳回首页。
  // 用户主动导航（主页按钮/右键修改 URL/弹窗转发）通过 safeLoadURLWebview 直接调用
  // webview.loadURL，不依赖 src attribute。
  const initialSrc = useMemo(
    () => sanitizeUrl(tab.url || profile.aiPlatformUrl || ''),
    // 仅在 tab.id 或 remountKey 变化（即 webview 实际销毁重建）时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.id, remountKey],
  );

  if (!initialSrc) return null;

  return (
    <webview
      key={`${tab.id}-${remountKey}`}
      ref={ref as React.RefObject<HTMLElement> as React.RefObject<WebviewElement>}
      src={initialSrc}
      partition={`persist:${profile.id}`}
      useragent={profile.userAgent || undefined}
      {...({ allowpopups: 'true', backgroundcolor: 'transparent' } as Record<string, unknown>)}
      data-tab-id={tab.id}
      data-name="main.webview-tab.webview"
      data-id={tab.id}
      style={{
        border: 'none',
        outline: 'none',
        boxShadow: 'none',
        display: 'flex',
        visibility: active ? 'visible' : 'hidden',
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
    />
  );
}
