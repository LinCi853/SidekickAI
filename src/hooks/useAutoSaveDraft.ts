import { useEffect, useRef, useCallback } from 'react';

interface UseAutoSaveDraftOptions<T> {
  data: T;
  save: (data: T) => Promise<void> | void;
  saveSync?: (data: T) => void;
  /** Explicit flush calls reject; background saves report failures. */
  onError?: (error: unknown) => void;
  debounceMs?: number;
  enabled?: boolean;
}

interface UseAutoSaveDraftResult {
  schedule: () => void;
  flushNow: () => Promise<void>;
}

interface HandoffSaveDetail {
  waitUntil(promise: Promise<unknown>): void;
  suppressPrompts?: boolean;
}

/** Serialize draft persistence and contribute awaited saves to application handoff. */
export function useAutoSaveDraft<T>(opts: UseAutoSaveDraftOptions<T>): UseAutoSaveDraftResult {
  const { data, save, saveSync, onError, debounceMs = 800, enabled = true } = opts;
  const dataRef = useRef(data);
  const saveRef = useRef(save);
  const saveSyncRef = useRef(saveSync);
  const onErrorRef = useRef(onError);
  const enabledRef = useRef(enabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(false);
  const revisionRef = useRef(0);
  const syncFenceRef = useRef<{ revision: number; data: T; save: (data: T) => void } | null>(null);
  const handoffRef = useRef(false);

  dataRef.current = data;
  saveRef.current = save;
  saveSyncRef.current = saveSync;
  onErrorRef.current = onError;
  enabledRef.current = enabled;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const reportError = useCallback((error: unknown, quiet = handoffRef.current) => {
    console.error('[AutoSave] Pending changes could not be saved', error);
    if (quiet || handoffRef.current) return;
    try { onErrorRef.current?.(error); }
    catch (reportingError) { console.error('[AutoSave] Error notification failed', reportingError); }
  }, []);

  const flushNow = useCallback((): Promise<void> => {
    clearTimer();
    if (!enabledRef.current) return Promise.resolve();
    const revision = ++revisionRef.current;
    const snapshot = dataRef.current;
    const persist = saveRef.current;
    const quiet = handoffRef.current;
    const wasPending = pendingRef.current;
    pendingRef.current = true;
    const operation = async () => {
      try {
        await persist(snapshot);
      } finally {
        // Restore a synchronous unload snapshot after an older asynchronous writer finishes.
        const fence = syncFenceRef.current;
        if (fence && fence.revision > revision) fence.save(fence.data);
      }
    };
    const write = wasPending ? queueRef.current.then(operation, async previousError => {
      await operation();
      if (!quiet) throw previousError;
    }) : operation();
    const reported = write.catch(error => { reportError(error, quiet); throw error; });
    queueRef.current = reported;
    void reported.finally(() => {
      if (queueRef.current === reported) pendingRef.current = false;
    }).catch(() => {});
    return reported;
  }, [clearTimer, reportError]);

  const schedule = useCallback(() => {
    if (!enabledRef.current || handoffRef.current) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushNow().catch(() => {});
    }, debounceMs);
  }, [clearTimer, debounceMs, flushNow]);

  useEffect(() => {
    const handoff = (event: Event) => {
      if (!enabledRef.current) return;
      const detail = (event as CustomEvent<HandoffSaveDetail>).detail;
      if (!detail?.waitUntil) { unload(event); return; }
      handoffRef.current = detail.suppressPrompts !== false;
      detail.waitUntil(flushNow());
    };
    const cancelHandoff = () => { handoffRef.current = false; };
    const unload = (event: Event) => {
      if (!enabledRef.current) return;
      clearTimer();
      if (handoffRef.current && event.type === 'beforeunload') return;
      const persist = saveSyncRef.current;
      if (!persist) return;
      try {
        const snapshot = dataRef.current;
        persist(snapshot);
        syncFenceRef.current = { revision: ++revisionRef.current, data: snapshot, save: persist };
      } catch (error) {
        reportError(error);
        event.preventDefault();
        if (event.type === 'beforeunload') (event as BeforeUnloadEvent).returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('sidekick:before-handoff', handoff);
    window.addEventListener('sidekick:cancel-handoff', cancelHandoff);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('sidekick:before-handoff', handoff);
      window.removeEventListener('sidekick:cancel-handoff', cancelHandoff);
    };
  }, [clearTimer, flushNow, reportError]);

  useEffect(() => () => {
    clearTimer();
    if (!handoffRef.current) void flushNow().catch(() => {});
  }, [clearTimer, flushNow]);

  return { schedule, flushNow };
}
