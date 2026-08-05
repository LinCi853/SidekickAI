import { useCallback, useRef, useState } from 'react';
import { getWindowBounds } from '../../../lib/electron-api';

/**
 * Manages tab drag-sort and drag-to-detach behavior.
 */
export function useTabDragSort(
  moveTab: (draggingId: string, targetId: string) => void,
  detachTab: (tabId: string) => void,
) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [hoverTabId, setHoverTabId] = useState<string | null>(null);
  const draggingTabRef = useRef<string | null>(null);

  const handleTabDragOver = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (draggingTabId && draggingTabId !== targetTabId) {
      setHoverTabId(targetTabId);
    }
  }, [draggingTabId]);

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault();
    if (draggingTabId && draggingTabId !== targetTabId) {
      moveTab(draggingTabId, targetTabId);
    }
    setHoverTabId(null);
  }, [draggingTabId, moveTab]);

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    draggingTabRef.current = tabId;
    setDraggingTabId(tabId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  const handleTabDragEnd = useCallback(
    async (e: React.DragEvent) => {
      const tabId = draggingTabRef.current;
      draggingTabRef.current = null;
      setDraggingTabId(null);
      setHoverTabId(null);
      if (!tabId) return;
      const { screenX, screenY } = e;
      try {
        const bounds = await getWindowBounds();
        const outside =
          screenX < (bounds.x ?? 0) ||
          screenX > (bounds.x ?? 0) + bounds.width ||
          screenY < (bounds.y ?? 0) ||
          screenY > (bounds.y ?? 0) + bounds.height;
        if (outside) {
          void detachTab(tabId);
        }
      } catch (err) {
        console.error('[MainView] 拖拽脱离判断失败:', err);
      }
    },
    [detachTab],
  );

  return {
    draggingTabId,
    hoverTabId,
    handleTabDragOver,
    handleTabDrop,
    handleTabDragStart,
    handleTabDragEnd,
  };
}
