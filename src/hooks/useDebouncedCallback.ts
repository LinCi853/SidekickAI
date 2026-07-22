import { useEffect, useRef } from 'react';

/**
 * 防抖回调 hook
 *
 * 返回一个稳定引用的防抖函数：调用后延迟 delay ms 执行 fn；
 * 在定时器到期前再次调用会清除旧定时器并重新计时；
 * 组件卸载时清除待执行定时器。
 *
 * @param fn    实际要执行的业务函数（通过 ref 持有最新引用）
 * @param delay 延迟毫秒数
 */
export function useDebouncedCallback<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const delayRef = useRef(delay);
  delayRef.current = delay;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 稳定引用的防抖函数（仅创建一次）
  const debouncedRef = useRef<((...args: Parameters<T>) => void) | null>(null);
  if (debouncedRef.current === null) {
    debouncedRef.current = (...args: Parameters<T>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        fnRef.current(...args);
      }, delayRef.current);
    };
  }

  // 卸载时清除定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return debouncedRef.current as T;
}
