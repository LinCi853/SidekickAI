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
  /** Reports failed saves; explicit flushNow calls still reject. */
  onError?: (error: unknown) => void;
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
  const { data, save, saveSync, onError, debounceMs = 800, enabled = true } = opts;

  // 通过 ref 持有最新值，避免闭包陷阱
  const dataRef = useRef(data);
  const saveRef = useRef(save);
  const saveSyncRef = useRef(saveSync);
  const onErrorRef = useRef(onError);
  const enabledRef = useRef(enabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  dataRef.current = data;
  saveRef.current = save;
  saveSyncRef.current = saveSync;
  onErrorRef.current = onError;
  enabledRef.current = enabled;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reportError = useCallback((error: unknown) => {
    console.error('[AutoSave] Pending changes could not be saved', error);
    try { onErrorRef.current?.(error); }
    catch (reportingError) { console.error('[AutoSave] Error notification failed', reportingError); }
  }, []);

  const flushNow = useCallback(async (): Promise<void> => {
    clearTimer();
    if (!enabledRef.current) return;
    try { await saveRef.current(dataRef.current); }
    catch (error) {
      reportError(error);
      throw error;
    }
  }, [clearTimer, reportError]);

  const schedule = useCallback(() => {
    if (!enabledRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Background callers report failures without leaving an unhandled rejection.
      void flushNow().catch(() => {});
    }, debounceMs);
  }, [clearTimer, debounceMs, flushNow]);

  // beforeunload 同步兜底
  useEffect(() => {
    const handler = (event: Event) => {
      if (!enabledRef.current) return;
      clearTimer();
      if (saveSyncRef.current) {
        try { saveSyncRef.current(dataRef.current); }
        catch (error) {
          reportError(error);
          event.preventDefault();
          if (event.type === 'beforeunload') (event as BeforeUnloadEvent).returnValue = '';
        }
      }
    };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('sidekick:before-handoff', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('sidekick:before-handoff', handler);
    };
  }, [clearTimer, reportError]);

  // 组件卸载前 flush（fire-and-forget）
  useEffect(() => {
    return () => {
      clearTimer();
      void flushNow().catch(() => {});
    };
  }, [clearTimer, flushNow]);

  return { schedule, flushNow };
}
