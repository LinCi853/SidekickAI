/* =====================================================================
   pages/BrowserView/ZoomIndicator.tsx —— 页面缩放浮窗（右上角）
   缩放变化时显示：当前百分比 + 放大 / 缩小 / 重置按钮。
   2.5 秒后自动隐藏；鼠标悬停保持显示。缩放动作统一由父级注入。
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useZoomStore, zoomLevelToPercent } from '../../store/useZoomStore';

interface ZoomIndicatorProps {
  /** 放大（+0.5 级） */
  onZoomIn: () => void;
  /** 缩小（-0.5 级） */
  onZoomOut: () => void;
  /** 重置为 100% */
  onZoomReset: () => void;
}

export default function ZoomIndicator({ onZoomIn, onZoomOut, onZoomReset }: ZoomIndicatorProps) {
  const level = useZoomStore((s) => s.level);
  const visible = useZoomStore((s) => s.visible);
  const hide = useZoomStore((s) => s.hide);
  const [hovered, setHovered] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 显示时启动自动隐藏计时（hover 时暂停）
  useEffect(() => {
    if (!visible) return;
    if (hovered) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      return;
    }
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => hide(), 2500);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [visible, hovered, hide]);

  if (!visible) return null;

  return (
    <div
      className="browser-zoom-indicator"
      data-name="browser.zoom-indicator"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="browser-zoom-percent" data-name="browser.zoom-percent">{zoomLevelToPercent(level)}</span>
      <button type="button" className="browser-zoom-btn" onClick={onZoomOut} title="缩小 (Ctrl+-)" data-name="browser.zoom.out">−</button>
      <button type="button" className="browser-zoom-btn" onClick={onZoomReset} title="重置缩放 (Ctrl+0)" data-name="browser.zoom.reset">重置</button>
      <button type="button" className="browser-zoom-btn" onClick={onZoomIn} title="放大 (Ctrl+=)" data-name="browser.zoom.in">＋</button>
    </div>
  );
}
