import { useEffect, useRef, useCallback } from 'react';

/**
 * 自动保存草稿 hook
 *
 * 封装「防抖保存 + beforeunload 同步兜底 + 卸载前 flush」三段耦合逻辑。
 *
 * 设计要点：
 * - save / saveSync 通过 ref 持有最新引用，避免闭包陷阱；组件可将其闭包内
 *   的 ref（如 draftRef / editorRef）在调用时读取，保证拿到最新数据。
 * - schedule()：触发防抖保存（清除旧定时器、设置新定时器），供编辑器内容
 *   变化 / store.listen 等场景手动调用。
 * - flushNow()：立即保存（清除定时器 + 同步调用 save），返回 Promise 供
 *   调用方 await（如切换笔记前等待保存完成）。
 * - beforeunload：注册 window 事件，调用 saveSync 做同步 IPC 兜底。
 * - 组件卸载：清除定时器 + 调用 save（fire-and-forget）。
 *
 * @param opts.data       待保存的数据（ref 内保存，供 save/saveSync 使用）
 * @param opts.save       异步保存
 * @param opts.saveSync   同步保存（beforeunload 兜底）
 * @param opts.debounceMs 防抖时间，默认 800
 * @param opts.enabled    是否启用自动保存，默认 true
 */
interface UseAutoSaveDraftOptions<T> {
  data: T;
  save: (data: T) => Promise<void> | void;
  saveSync?: (data: T) => void;
  debounceMs?: number;
  enabled?: boolean;
}

interface UseAutoSaveDraftResult {
  /** 触发防抖保存（清除旧定时器、设置新定时器） */
  schedule: () => void;
  /** 立即保存（清除定时器 + 调用 save），返回 Promise 供 await */
  flushNow: () => Promise<void>;
}

export function useAutoSaveDraft<T>(
  opts: UseAutoSaveDraftOptions<T>
): UseAutoSaveDraftResult {
  const { data, save, saveSync, debounceMs = 800, enabled = true } = opts;

  // 通过 ref 持有最新值，避免闭包陷阱
  const dataRef = useRef(data);
  const saveRef = useRef(save);
  const saveSyncRef = useRef(saveSync);
  const enabledRef = useRef(enabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  dataRef.current = data;
  saveRef.current = save;
  saveSyncRef.current = saveSync;
  enabledRef.current = enabled;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flushNow = useCallback((): Promise<void> => {
    clearTimer();
    if (!enabledRef.current) return Promise.resolve();
    const result = saveRef.current(dataRef.current);
    return result instanceof Promise ? result : Promise.resolve();
  }, [clearTimer]);

  const schedule = useCallback(() => {
    if (!enabledRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveRef.current(dataRef.current);
    }, debounceMs);
  }, [clearTimer, debounceMs]);

  // beforeunload 同步兜底
  useEffect(() => {
    const handler = () => {
      if (!enabledRef.current) return;
      clearTimer();
      if (saveSyncRef.current) {
        saveSyncRef.current(dataRef.current);
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [clearTimer]);

  // 组件卸载前 flush（fire-and-forget）
  useEffect(() => {
    return () => {
      clearTimer();
      if (enabledRef.current) {
        void saveRef.current(dataRef.current);
      }
    };
  }, [clearTimer]);

  return { schedule, flushNow };
}
