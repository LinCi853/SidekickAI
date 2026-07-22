import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseToastReturn {
  /** 当前 toast 消息，为 null 表示隐藏 */
  toast: string | null;
  /** 显示 toast 消息，并在 duration 后自动清除；重复调用会清除旧定时器并重新计时 */
  showToast: (msg: string) => void;
  /** 立即清除 toast 并取消待执行的定时器 */
  clearToast: () => void;
}

/**
 * Toast 提示 hook
 *
 * showToast 设置消息并启动 setTimeout 在 duration（默认 2000ms）后清除；
 * 重复调用时清除旧定时器，重新计时。组件卸载时清除定时器。
 *
 * @param duration toast 显示时长（毫秒），默认 2000
 */
export function useToast(duration: number = 2000): UseToastReturn {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToast = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback(
    (msg: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast(msg);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setToast(null);
      }, duration);
    },
    [duration]
  );

  // 卸载时清除定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toast, showToast, clearToast };
}
