/* 通用侧边栏拖拽调宽手柄，放在侧边栏右边缘 */
import { useCallback, useEffect, useRef } from 'react';

export interface SidebarResizerProps {
  /** 当前宽度 */
  width: number;
  /** 最小宽度 */
  minWidth: number;
  /** 最大宽度 */
  maxWidth: number;
  /** 拖拽松开时回调，传入新宽度 */
  onResize: (width: number) => void;
  /** 拖拽过程中实时回调（可选，用于即时反馈） */
  onResizePreview?: (width: number) => void;
}

export default function SidebarResizer({ width, minWidth, maxWidth, onResize, onResizePreview }: SidebarResizerProps) {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      onResizePreview?.(next);
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const delta = e.clientX - startXRef.current;
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      onResize(next);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minWidth, maxWidth, onResize, onResizePreview]);

  return (
    <div
      className="sidebar-resizer"
      onMouseDown={handleMouseDown}
      title="拖拽调整侧边栏宽度"
      data-name="component.sidebar-resizer"
    />
  );
}
