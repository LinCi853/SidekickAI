import { useEffect, useState } from 'react';
import {
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onPinToggled,
  onMaximizeToggled,
} from '@/lib/electron-api';

/**
 * 窗口最大化/置顶状态 hook
 *
 * 初始化时查询当前窗口的最大化和置顶状态，
 * 并监听主进程推送的状态变更（F12 拦截器触发）。
 * 返回状态及对应的 setter，供顶栏按钮乐观更新使用。
 */
export function useWindowMaximizedAndPinned() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    void isWindowMaximized().then(setIsMaximized).catch(() => {});
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
    const offPin = onPinToggled((pinned) => setIsPinned(pinned));
    const offMax = onMaximizeToggled((maximized) => setIsMaximized(maximized));
    return () => {
      offPin();
      offMax();
    };
  }, []);

  return { isMaximized, isPinned, setIsMaximized, setIsPinned };
}
