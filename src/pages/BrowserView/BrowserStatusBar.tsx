/* =====================================================================
   pages/BrowserView/BrowserStatusBar.tsx —— 浏览器窗口底部状态栏
   - 加载进度条（0-100%）：加载时显示，完成后淡出
   - 状态文本："正在连接..." → "等待响应..." → "已完成"
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useBrowserTabStore } from '../../store/useBrowserTabStore';

type Phase = 'hidden' | 'loading' | 'completed';

export default function BrowserStatusBar() {
  const tabs = useBrowserTabStore((s) => s.tabs);
  const activeTabId = useBrowserTabStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const isLoading = activeTab?.isLoading ?? false;
  const progress = activeTab?.loadingProgress ?? 0;
  const statusText = activeTab?.loadingStatus ?? '';

  const [phase, setPhase] = useState<Phase>('hidden');
  const prevLoadingRef = useRef(false);
  const prevTabIdRef = useRef(activeTabId);

  useEffect(() => {
    // 切换标签：重置为当前标签的加载状态
    if (prevTabIdRef.current !== activeTabId) {
      prevTabIdRef.current = activeTabId;
      prevLoadingRef.current = isLoading;
      setPhase(isLoading ? 'loading' : 'hidden');
      return;
    }

    if (isLoading) {
      setPhase('loading');
      prevLoadingRef.current = true;
    } else if (prevLoadingRef.current) {
      // 从加载中变为非加载：显示"已完成"后延迟隐藏
      setPhase('completed');
      prevLoadingRef.current = false;
      const timer = setTimeout(() => setPhase('hidden'), 800);
      return () => clearTimeout(timer);
    }
  }, [isLoading, activeTabId]);

  if (phase === 'hidden') return null;

  const showProgress = phase === 'loading';
  const displayText = phase === 'loading'
    ? (statusText || '正在连接...')
    : '已完成';

  return (
    <div
      style={{
        position: 'relative',
        flex: 'none',
        height: '22px',
        display: 'flex',
        alignItems: 'center',
        background: 'var(--glass-bg, #1e1e1e)',
        borderTop: '1px solid var(--glass-bd, rgba(255,255,255,0.08))',
        overflow: 'hidden',
        opacity: phase === 'completed' ? 0.6 : 1,
        transition: 'opacity 0.3s ease',
        zIndex: 10,
      }}
    >
      {/* 顶部进度条 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '2px',
          width: `${showProgress ? progress : 100}%`,
          background: 'var(--accent, #c25a4a)',
          boxShadow: '0 0 4px var(--accent, #c25a4a)',
          transition: 'width 0.3s ease, opacity 0.4s ease',
          opacity: showProgress ? 1 : 0,
        }}
      />
      {/* 状态文本 */}
      <span
        style={{
          padding: '0 12px',
          fontSize: '11px',
          color: 'var(--muted-foreground, #999)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {displayText}
      </span>
    </div>
  );
}
