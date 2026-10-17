import { useEffect, useMemo } from 'react';
import { syncTabProcessPriority } from '../lib/electron-api';

/** 同步激活和受保护标签；优先级调整不卸载网页。 */
export function useTabProcessPriority({ windowId, tabs, activeTabId, isProtected }: {
  windowId: string;
  tabs: ReadonlyArray<{ id: string }>;
  activeTabId: string | null;
  isProtected?: (tabId: string) => boolean;
}) {
  const audibleTabIds = useMemo(() => tabs.filter(tab => isProtected?.(tab.id)).map(tab => tab.id), [tabs, isProtected]);
  useEffect(() => {
    if (!windowId) return;
    void syncTabProcessPriority({ windowId, activeTabId, audibleTabIds }).catch(() => {});
  }, [windowId, activeTabId, audibleTabIds]);
}
