/* =====================================================================
   pages/BrowserView/hooks/useWebviewLoadingProgress.ts —— 加载进度状态机
   抽取自 BrowserWebviewTab.tsx：NavBar 渐进式进度条 + 加载状态文本
   + did-stop-loading 兜底读取 title/favicon + 卸载时清理定时器。
   ===================================================================== */

import { useCallback, useEffect, useRef } from 'react';
import type { BrowserTabState } from '../../../lib/electron-api';
import type { WebviewElement } from '../../../lib/webview.js';
import { useBrowserTabStore } from '../../../store/useBrowserTabStore.js';
import { GET_TITLE_SCRIPT, buildFaviconToDataUrlScript } from '../webview-scripts.js';

export interface UseWebviewLoadingProgressParams {
  webviewRef: React.MutableRefObject<WebviewElement | null>;
  domReadyRef: React.MutableRefObject<boolean>;
  tab: BrowserTabState;
}

export function useWebviewLoadingProgress({ webviewRef, domReadyRef, tab }: UseWebviewLoadingProgressParams) {
  const store = useBrowserTabStore();
  // B2: NavBar 加载进度条 —— 渐进模拟 interval 与隐藏定时器
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleStartLoading = useCallback(() => {
    store.updateTabLoading(tab.id, true);
    store.updateTabLoadingStatus(tab.id, '正在连接...');
    // B2: 启动进度条 —— 设为 10，并启动渐进模拟（10→30→50→70→90）
    if (progressHideTimerRef.current) {
      clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
    store.updateTabLoadingProgress(tab.id, 10);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    const steps = [30, 50, 70, 90];
    let stepIdx = 0;
    progressIntervalRef.current = setInterval(() => {
      if (stepIdx < steps.length) {
        store.updateTabLoadingProgress(tab.id, steps[stepIdx]);
        stepIdx += 1;
      } else {
        // 停在 90，等待实际加载完成事件跳到 100
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
          progressIntervalRef.current = null;
        }
      }
    }, 400);
  }, [tab.id, store]);

  // B2: did-finish-navigation —— 导航完成（DOM 开始构建）设为 60
  const handleFinishNavigation = useCallback(() => {
    store.updateTabLoadingProgress(tab.id, 60);
    store.updateTabLoadingStatus(tab.id, '等待响应...');
  }, [tab.id, store]);

  // B2: did-finish-load —— 页面完全加载：设为 100，500ms 后隐藏（设为 0 + isLoading=false）
  const handleFinishLoad = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    store.updateTabLoadingProgress(tab.id, 100);
    store.updateTabLoadingStatus(tab.id, '已完成');
    if (progressHideTimerRef.current) return; // 已有定时器，避免重复
    progressHideTimerRef.current = setTimeout(() => {
      progressHideTimerRef.current = null;
      store.updateTabLoadingProgress(tab.id, 0);
      store.updateTabLoadingStatus(tab.id, '');
      store.updateTabLoading(tab.id, false);
    }, 500);
  }, [tab.id, store]);

  const handleStopLoading = useCallback(() => {
    // B2: 兜底 —— did-finish-load 未触发时由 did-stop-loading 完成隐藏流程
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    store.updateTabLoadingProgress(tab.id, 100);
    store.updateTabLoadingStatus(tab.id, '已完成');
    if (!progressHideTimerRef.current) {
      progressHideTimerRef.current = setTimeout(() => {
        progressHideTimerRef.current = null;
        store.updateTabLoadingProgress(tab.id, 0);
        store.updateTabLoadingStatus(tab.id, '');
        store.updateTabLoading(tab.id, false);
      }, 500);
    }

    // 兜底：页面加载完成后主动读取 title 和 favicon
    // 解决 page-title-updated / page-favicon-updated 事件可能不触发的问题
    const webview = webviewRef.current;
    if (!webview || !domReadyRef.current) return;
    try {
      // 读取 document.title
      void webview.executeJavaScript(GET_TITLE_SCRIPT).then((title) => {
        if (title && typeof title === 'string' && tab.source !== 'initial') {
          store.updateTabTitle(tab.id, title);
        }
      }).catch(() => { /* ignore */ });

      // 读取 favicon 并转换为 data URL
      void webview.executeJavaScript(buildFaviconToDataUrlScript()).then((favicon) => {
        if (favicon && typeof favicon === 'string' && favicon.length > 10) {
          store.updateTabFavicon(tab.id, favicon);
        }
      }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }, [tab.id, tab.source, store]);

  // did-fail-load —— 加载失败：更新状态文本
  const handleFailLoad = useCallback(() => {
    store.updateTabLoadingStatus(tab.id, '加载失败');
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
    if (!progressHideTimerRef.current) {
      progressHideTimerRef.current = setTimeout(() => {
        progressHideTimerRef.current = null;
        store.updateTabLoadingProgress(tab.id, 0);
        store.updateTabLoadingStatus(tab.id, '');
        store.updateTabLoading(tab.id, false);
      }, 800);
    }
  }, [tab.id, store]);

  // B2: 卸载时清理进度条 interval/timer，避免泄漏与跨标签串扰
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      if (progressHideTimerRef.current) {
        clearTimeout(progressHideTimerRef.current);
        progressHideTimerRef.current = null;
      }
    };
  }, []);

  return {
    handleStartLoading,
    handleFinishNavigation,
    handleFinishLoad,
    handleStopLoading,
    handleFailLoad,
  };
}
