import { useCallback, useEffect, useRef, useState } from 'react';
import type { Profile } from '../../../lib/electron-api';
import { sanitizeUrl, type WebviewElement } from '../../../lib/webview';
import { useTabStore } from '../../../store/useTabStore';

/**
 * 4.2 检测 webview 是否有活跃的网络请求（如 AI 流式回复）。
 * 通过 executeJavaScript 注入脚本读取 performance API：
 *   - 检查最近 2 秒内发起且尚未完成的资源请求（duration === 0 表示尚未完成）
 *   - 或文档未完成加载
 * 用于 UA 变化触发 reload 前判断是否需要延缓，避免丢失流式数据。
 */
async function checkWebviewStreaming(webview: WebviewElement): Promise<boolean> {
  try {
    const result = await webview.executeJavaScript(`
      (function() {
        var entries = performance.getEntriesByType('resource');
        var now = performance.now();
        // 检查最近 2 秒内发起且尚未完成的资源请求（duration === 0 表示尚未完成）
        var active = entries.filter(function(e) { return now - e.startTime < e.duration + 2000 && e.duration === 0; });
        return active.length > 0 || document.readyState !== 'complete';
      })()
    `);
    return Boolean(result);
  } catch (e) {
    // 检测失败时保守处理：返回 false（不延缓 reload），避免阻塞用户操作
    console.warn('[WebviewTab] 流式检测失败，不延缓 reload:', e);
    return false;
  }
}

export function useWebviewRemount({
  tab,
  profile,
  onDomReadyChange,
}: {
  tab: { id: string };
  profile: Profile;
  onDomReadyChange?: (isReady: boolean) => void;
}) {
  // remount 计数器：guest 进程彻底死亡时递增，通过 key 变化强制 React 销毁并重建 <webview> 元素
  // 这是唯一可靠的恢复手段 —— 当 guest 死亡时，reload/loadURL/src 赋值全部通过
  // GUEST_VIEW_MANAGER_CALL IPC 异步失败，只有销毁 DOM 元素才能触发 Electron 创建新 guest
  const [remountKey, setRemountKey] = useState(0);
  // webview 是否已 dom-ready（executeJavaScript 必须在 ready 后调用，否则同步抛错）
  const domReadyRef = useRef(false);
  // remount 防循环：记录上次 remount 失败的 URL 和连续失败次数
  // 同一 URL 连续 remount 失败 ≥2 次时，回退到 profile 首页 URL 并重置计数器
  const lastRemountFailUrlRef = useRef<string>('');
  const remountFailCountRef = useRef<number>(0);

  // dom-ready 状态回调 ref（避免 webview setup effect 依赖 onDomReadyChange 导致重复挂载）
  const onDomReadyChangeRef = useRef(onDomReadyChange);
  useEffect(() => { onDomReadyChangeRef.current = onDomReadyChange; });

  // 4.2 UA 变化触发 reload 的延缓管理：
  //   - pendingReloadRef：是否已有等待中的 reload（避免重复调度）
  //   - reloadPollTimerRef：数据流转完成轮询定时器（每 500ms 检测）
  //   - reloadTimeoutRef：超时兜底定时器（10s 后强制 reload）
  const pendingReloadRef = useRef(false);
  const reloadPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 4.2 调度 reload：若 webview 正在数据流转（AI 流式回复等）则延缓 reload，
   * 轮询检测数据流转完成后执行；含 10s 超时兜底防止检测失效导致永不刷新。
   *
   * 两处调用点（profile UA 变化 + 窄屏/宽屏 UA 自动切换）统一使用本函数。
   */
  const scheduleReload = useCallback((webview: WebviewElement) => {
    // 已有 pending reload，不重复调度
    if (pendingReloadRef.current) {
      console.log('[WebviewTab] 已有 pending reload，跳过本次调度');
      return;
    }

    void checkWebviewStreaming(webview).then((streaming) => {
      if (!streaming) {
        // 无活跃数据流转：立即 reload
        console.log('[WebviewTab] 无活跃数据流转，立即 reload');
        try {
          webview.reload();
        } catch (e) {
          console.error('[WebviewTab] reload 失败:', e);
        }
        return;
      }

      // 有活跃数据流转：设置 pending 标记，启动轮询 + 超时兜底
      console.log('[WebviewTab] 检测到活跃数据流转，延缓 reload');
      pendingReloadRef.current = true;

      // 轮询：每 500ms 检测一次，数据流转完成后执行 reload
      reloadPollTimerRef.current = setInterval(() => {
        void checkWebviewStreaming(webview).then((stillStreaming) => {
          if (!stillStreaming) {
            console.log('[WebviewTab] 数据流转完成，执行延缓的 reload');
            // 清理定时器
            if (reloadPollTimerRef.current) {
              clearInterval(reloadPollTimerRef.current);
              reloadPollTimerRef.current = null;
            }
            if (reloadTimeoutRef.current) {
              clearTimeout(reloadTimeoutRef.current);
              reloadTimeoutRef.current = null;
            }
            pendingReloadRef.current = false;
            try {
              webview.reload();
            } catch (e) {
              console.error('[WebviewTab] 延缓 reload 执行失败:', e);
            }
          }
        });
      }, 500);

      // 超时兜底：10 秒后强制 reload，防止检测失效导致永不刷新
      reloadTimeoutRef.current = setTimeout(() => {
        console.warn('[WebviewTab] 延缓 reload 超时 10s，强制 reload');
        if (reloadPollTimerRef.current) {
          clearInterval(reloadPollTimerRef.current);
          reloadPollTimerRef.current = null;
        }
        pendingReloadRef.current = false;
        try {
          webview.reload();
        } catch (e) {
          console.error('[WebviewTab] 强制 reload 失败:', e);
        }
      }, 10000);
    });
  }, []);

  // 组件卸载时清理 reload 相关定时器，避免内存泄漏
  useEffect(() => {
    return () => {
      if (reloadPollTimerRef.current) {
        clearInterval(reloadPollTimerRef.current);
        reloadPollTimerRef.current = null;
      }
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }
      pendingReloadRef.current = false;
    };
  }, []);

  const resetRemountFailState = useCallback(() => {
    lastRemountFailUrlRef.current = '';
    remountFailCountRef.current = 0;
  }, []);

  // 触发 remount，带防循环保护：
  //   - 同一 URL 连续 remount 失败 ≥2 次时，回退到 profile.aiPlatformUrl 并重置计数
  //   - remount 后若新 webview 成功 dom-ready（见 handleDomReady），重置计数器
  //   - guest 崩溃 / ERR_FAILED 持续 / safeLoadURLWebview 失败 三种场景共用此函数
  // 防循环动机：aistudio.xiaomimimo.com 内 window.open 跳转到 platform.xiaomimimo.com
  //   被拦截后 loadURL 失败 → remount → 新 guest 加载同 URL 又失败 → 无限循环。
  //   通过记录上次失败 URL + 连续失败次数，≥2 次时改加载 profile 首页打破循环。
  // 注意：tab.url 在 effect 闭包中可能已过期，从 store 实时读取最新值做比较。
  const triggerRemount = useCallback((failUrl: string, reason: string, updateTabToFailUrl: boolean) => {
    const cleanFailUrl = sanitizeUrl(failUrl);
    // 从 store 读取最新 tab.url，避免闭包捕获过期值导致重复 updateTabUrl
    const currentTabUrl = useTabStore.getState().tabs.find((t) => t.id === tab.id)?.url || '';
    if (cleanFailUrl && cleanFailUrl === lastRemountFailUrlRef.current) {
      remountFailCountRef.current += 1;
      if (remountFailCountRef.current >= 2) {
        // 同一 URL 连续 remount 失败 ≥2 次：回退到 profile 首页，打破循环
        const homeUrl = sanitizeUrl(profile.aiPlatformUrl || '');
        console.warn(`[WebviewTab] ${reason}: 同一 URL 连续失败 ${remountFailCountRef} 次，回退首页:`, cleanFailUrl, '→', homeUrl);
        if (homeUrl && homeUrl !== cleanFailUrl) {
          lastRemountFailUrlRef.current = homeUrl;
          remountFailCountRef.current = 1; // 首页也算一次尝试，若首页也失败则下次走 homeUrl === cleanFailUrl 分支
          void useTabStore.getState().updateTabUrl(tab.id, homeUrl);
        } else {
          // 首页 URL 缺失或与失败 URL 相同：无法回退，重置计数后仅 remount 一次
          remountFailCountRef.current = 0;
          lastRemountFailUrlRef.current = '';
        }
        domReadyRef.current = false;
        onDomReadyChangeRef.current?.(false);
        setRemountKey((k) => k + 1);
        return;
      }
    } else {
      // 不同 URL：重置计数器为 1（首次失败）
      lastRemountFailUrlRef.current = cleanFailUrl;
      remountFailCountRef.current = 1;
    }
    // 默认路径：remount 同一 URL
    // updateTabToFailUrl=true（来自 handleFatalFailure）：先更新 tab.url 到目标 URL，
    // remount 后新 webview 的 src 会取自 tab.url
    if (updateTabToFailUrl && cleanFailUrl && cleanFailUrl !== currentTabUrl) {
      void useTabStore.getState().updateTabUrl(tab.id, cleanFailUrl);
    }
    console.warn(`[WebviewTab] ${reason}: 触发 remount:`, tab.id, 'URL:', cleanFailUrl);
    domReadyRef.current = false;
    onDomReadyChangeRef.current?.(false);
    setRemountKey((k) => k + 1);
  }, [tab.id, profile.aiPlatformUrl]);

  return { remountKey, domReadyRef, onDomReadyChangeRef, triggerRemount, resetRemountFailState, scheduleReload };
}
