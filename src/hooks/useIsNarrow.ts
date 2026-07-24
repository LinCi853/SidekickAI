import { useEffect, useState } from 'react';

/**
 * 窄屏检测 hook
 *
 * 监听窗口 resize 事件，判断窗口宽度是否小于指定阈值（默认 600px）。
 */
export function useIsNarrow(threshold = 600): boolean {
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < threshold : false,
  );

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < threshold);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [threshold]);

  return isNarrow;
}
