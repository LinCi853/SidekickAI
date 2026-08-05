import { useEffect, useRef } from 'react';
import { getPreset } from '../../../lib/electron-api';
import type { Profile } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview';

export function useWebviewUa({
  webviewRef,
  profile,
  isNarrow,
  desktopPresetId,
  mobilePresetId,
  domReadyRef,
  scheduleReload,
}: {
  webviewRef: React.RefObject<WebviewElement | null>;
  profile: Profile;
  isNarrow: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
  domReadyRef: React.MutableRefObject<boolean>;
  scheduleReload: (webview: WebviewElement) => void;
}) {
  // profile UA / 设备预设变化时刷新 webview，使新 UA 生效
  const uaInitializedRef = useRef(false);
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !profile.userAgent) return;
    // 首次挂载不 reload（避免与初始 src 加载冲突），之后 UA/设备变化才刷新
    if (!uaInitializedRef.current) {
      uaInitializedRef.current = true;
      return;
    }
    console.log('[WebviewTab] profile UA 已更新，刷新页面:', profile.name, profile.userAgent.slice(0, 40));
    if (!domReadyRef.current) return; // webview 未 ready 时 reload 会抛错或无效
    // 4.2: 通过 scheduleReload 检测流式数据流转，避免在 AI 流式回复过程中刷新导致数据丢失
    scheduleReload(webview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.userAgent, profile.devicePreset]);

  // 窄屏/宽屏自动切换 UA：窄屏用移动端预设 UA，宽屏用桌面端预设 UA
  // UA 锁定模式（profile.uaLockMode）覆盖自动切换：
  //   - 'mobile'：强制使用移动端预设
  //   - 'desktop'：强制使用桌面端预设
  //   - 'auto' / 未定义：保持按 isNarrow 切换
  const prevPresetRef = useRef<string>('');
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const uaLock = profile.uaLockMode ?? 'auto';
    const targetPresetId =
      uaLock === 'mobile' ? mobilePresetId
      : uaLock === 'desktop' ? desktopPresetId
      : (isNarrow ? mobilePresetId : desktopPresetId);
    if (prevPresetRef.current === targetPresetId) return;
    prevPresetRef.current = targetPresetId;
    // 异步获取预设的 UA 并切换
    let cancelled = false;
    getPreset(targetPresetId)
      .then((preset) => {
        if (cancelled || !webview) return;
        const targetUA = preset?.userAgent ?? profile.userAgent;
        try {
          webview.setUserAgent(targetUA);
          console.log('[WebviewTab] UA 已切换:', uaLock !== 'auto' ? `锁定${uaLock}` : (isNarrow ? '移动端' : '桌面端'), targetUA.slice(0, 40));
          if (!domReadyRef.current) return; // webview 未 ready 时 reload 会抛错或无效
          // 4.2: 通过 scheduleReload 检测流式数据流转，避免在 AI 流式回复过程中刷新导致数据丢失
          scheduleReload(webview);
        } catch (e) {
          console.error('[WebviewTab] 切换 UA 失败:', e);
        }
      })
      .catch((e) => console.error('[WebviewTab] 获取预设失败:', e));
    return () => {
      cancelled = true;
    };
  }, [isNarrow, desktopPresetId, mobilePresetId, profile.userAgent, profile.uaLockMode]);
}
