import { useCallback, useEffect, useState } from 'react';
import {
  isWindowMaximized,
  isWindowAlwaysOnTop,
  maximizeToggleWindow,
  pinCurrentWindow,
  toggleFullscreenWindow,
  onPinToggled,
  onMaximizeToggled,
  onFullscreenToggled,
} from '@/lib/electron-api';

/**
 * 窗口最大化/置顶/全屏状态统一管理 hook
 *
 * 提供所有窗口共用的最大化/置顶/全屏状态管理：
 *   - 初始化时查询当前窗口的最大化和置顶状态
 *   - 监听主进程推送的状态变更（OS 原生最大化 / F12 拦截器 / 全屏切换）
 *   - 返回 handleMaximize / handleTogglePin / handleToggleFullscreen 统一回调
 *
 * 使用方式：
 *   const { isMaximized, isPinned, isFullscreen, handleMaximize, handleTogglePin } = useWindowMaximizedAndPinned();
 *
 * 替代各组件中重复的：
 *   const [isMaximized, setIsMaximized] = useState(false);
 *   useEffect(() => { isWindowMaximized().then(setIsMaximized); }, []);
 *   useEffect(() => { onMaximizeToggled(setIsMaximized); }, []);
 *   const handleMaximize = async () => { const next = await maximizeToggleWindow(); setIsMaximized(next); };
 */
export function useWindowMaximizedAndPinned() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    void isWindowMaximized().then(setIsMaximized).catch(() => {});
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
    const offPin = onPinToggled((pinned) => setIsPinned(pinned));
    const offMax = onMaximizeToggled((maximized) => setIsMaximized(maximized));
    const offFs = onFullscreenToggled((fullscreen) => setIsFullscreen(fullscreen));
    return () => {
      offPin();
      offMax();
      offFs();
    };
  }, []);

  /** 切换最大化/还原（统一入口，替代各组件重复的 handleMaximize） */
  const handleMaximize = useCallback(async () => {
    const next = await maximizeToggleWindow();
    setIsMaximized(next);
  }, []);

  /** 切换置顶（统一入口） */
  const handleTogglePin = useCallback(async () => {
    const next = !isPinned;
    setIsPinned(next);
    await pinCurrentWindow(next);
  }, [isPinned]);

  /** 切换全屏（统一入口） */
  const handleToggleFullscreen = useCallback(async () => {
    await toggleFullscreenWindow();
  }, []);

  return {
    isMaximized,
    isPinned,
    isFullscreen,
    setIsMaximized,
    setIsPinned,
    setIsFullscreen,
    handleMaximize,
    handleTogglePin,
    handleToggleFullscreen,
  };
}
