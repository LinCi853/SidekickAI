/* =====================================================================
   components/WindowResizeHandles.tsx —— 自定义窗口边缘拖拽 resize
   配合主进程 thickFrame: false 使用：Windows 原生 resize 边框被禁用后，
   在渲染层窗口四周放置 6px 透明拖拽条，通过 IPC 让主进程 setBounds。

   关键实现要点：
   1. setPointerCapture 必须在 onPointerDown 同步阶段调用——React 合成事件的
      e.currentTarget 在 await 后会被清空，异步调用 setPointerCapture 会静默失败。
   2. pointermove/pointerup 通过 React props（onPointerMove/onPointerUp）处理，
      而非 useEffect+addEventListener——capture 后事件路由到捕获元素，React props
      能正确接收。
   3. 不在拖拽时切换 pointer-events:none——capture 已保证事件独占，切换反而会导致
      捕获元素收不到事件，isDragging 卡死。
   4. onLostPointerCapture 兜底：系统抢占手势时清理状态，避免卡死。
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resizeWindow,
  getWindowBounds,
  getMinimumSize,
  isWindowMaximized,
  maximizeToggleWindow,
  onMaximizeToggled,
  onFullscreenToggled,
} from '../lib/electron-api';

type Edge = 'n' | 'sl' | 'sr' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const HANDLE_SIZE = 6;

const handleStyle = (edge: Edge): React.CSSProperties => {
  const base: React.CSSProperties = {
    position: 'fixed',
    // z-index 高于底栏（10001），确保底栏展开时仍可拖拽调整窗口大小
    zIndex: 10010,
    // 触摸/笔输入时关闭默认触摸行为，避免 pointer 事件被滚动/选择手势抢占
    touchAction: 'none',
  };
  switch (edge) {
    case 'n':
      return { ...base, top: 0, left: HANDLE_SIZE, right: HANDLE_SIZE, height: HANDLE_SIZE, cursor: 'ns-resize' };
    // 底部边缘拆为左右两段，中间 50% 留给底部抽屉手柄，避免拖拽冲突
    case 'sl':
      return { ...base, bottom: 0, left: HANDLE_SIZE, width: 'calc(25% - 6px)', height: HANDLE_SIZE, cursor: 'ns-resize' };
    case 'sr':
      return { ...base, bottom: 0, right: HANDLE_SIZE, width: 'calc(25% - 6px)', height: HANDLE_SIZE, cursor: 'ns-resize' };
    case 'e':
      return { ...base, top: HANDLE_SIZE, right: 0, bottom: HANDLE_SIZE, width: HANDLE_SIZE, cursor: 'ew-resize' };
    case 'w':
      return { ...base, top: HANDLE_SIZE, left: 0, bottom: HANDLE_SIZE, width: HANDLE_SIZE, cursor: 'ew-resize' };
    case 'ne':
      return { ...base, top: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE, cursor: 'nesw-resize' };
    case 'nw':
      return { ...base, top: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE, cursor: 'nwse-resize' };
    case 'se':
      return { ...base, bottom: 0, right: 0, width: HANDLE_SIZE, height: HANDLE_SIZE, cursor: 'nwse-resize' };
    case 'sw':
      return { ...base, bottom: 0, left: 0, width: HANDLE_SIZE, height: HANDLE_SIZE, cursor: 'nesw-resize' };
    default:
      return base;
  }
};

export interface WindowResizeHandlesProps {
  /** 禁用所有 resize 手柄（如底栏展开时释放窗口调整限制） */
  disabled?: boolean;
  /**
   * 最大化/全屏状态下的 resize 行为：
   * - 'block'：隐藏 resize 手柄，不允许拖拽调整大小（默认）
   * - 'unmaximize'：拖拽时自动退出最大化，然后正常 resize
   */
  fullscreenMode?: 'block' | 'unmaximize';
}

export default function WindowResizeHandles({ disabled = false, fullscreenMode = 'block' }: WindowResizeHandlesProps) {
  // 仅用于触发光标样式重渲染；拖拽逻辑全部用 ref，避免闭包陈旧
  const [activeEdge, setActiveEdge] = useState<Edge | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    isWindowMaximized().then(setIsMaximized).catch(() => {});
    const unsub = onMaximizeToggled(setIsMaximized);
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onFullscreenToggled(setIsFullscreen);
    return unsub;
  }, []);
  const startRef = useRef<{ x: number; y: number; bounds: { x: number; y: number; width: number; height: number } } | null>(null);
  const minSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<{ dx: number; dy: number } | null>(null);
  // edgeRef 替代 state 在 applyResize 中读取，避免 useCallback 依赖重建
  const edgeRef = useRef<Edge | null>(null);

  const applyResize = useCallback(() => {
    const start = startRef.current;
    const latest = latestRef.current;
    const edge = edgeRef.current;
    if (!start || !latest || !edge) return;
    const { dx, dy } = latest;
    let { x, y, width, height } = start.bounds;
    const { width: minW, height: minH } = minSizeRef.current;

    if (edge.includes('e')) width = Math.max(minW, start.bounds.width + dx);
    if (edge.includes('w')) {
      const newWidth = Math.max(minW, start.bounds.width - dx);
      x = start.bounds.x + (start.bounds.width - newWidth);
      width = newWidth;
    }
    if (edge.includes('s')) height = Math.max(minH, start.bounds.height + dy);
    if (edge.includes('n')) {
      const newHeight = Math.max(minH, start.bounds.height - dy);
      y = start.bounds.y + (start.bounds.height - newHeight);
      height = newHeight;
    }

    void resizeWindow({ x, y, width, height });
  }, []);

  const cleanup = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setActiveEdge(null);
    edgeRef.current = null;
    startRef.current = null;
    latestRef.current = null;
  }, []);

  const handlePointerDown = useCallback((edge: Edge, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // 最大化状态下：'block' 模式不渲染手柄所以不会到这里；
    // 'unmaximize' 模式先退出最大化再开始 resize
    if (isMaximized && fullscreenMode === 'unmaximize') {
      void maximizeToggleWindow().then(() => {
        setIsMaximized(false);
        // 退出最大化后重新获取 bounds，再开始 resize
        startPointerCapture(edge, e);
      });
      return;
    }

    startPointerCapture(edge, e);
  }, [isMaximized, fullscreenMode, cleanup]);

  /** 同步 capture + 异步获取 bounds 的实际逻辑 */
  const startPointerCapture = useCallback((edge: Edge, e: React.PointerEvent<HTMLDivElement>) => {
    // ★ 同步阶段调用 setPointerCapture——此时 e.currentTarget 有效。
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    edgeRef.current = edge;
    setActiveEdge(edge);

    const sx = e.screenX;
    const sy = e.screenY;
    void Promise.all([getWindowBounds(), getMinimumSize()]).then(([bounds, minSize]) => {
      startRef.current = {
        x: sx,
        y: sy,
        bounds: {
          x: bounds.x ?? 0,
          y: bounds.y ?? 0,
          width: bounds.width,
          height: bounds.height,
        },
      };
      minSizeRef.current = minSize;
    }).catch((err) => {
      console.error('[WindowResizeHandles] 获取 bounds/minSize 失败:', err);
      cleanup();
    });
  }, [cleanup]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    latestRef.current = { dx: e.screenX - start.x, dy: e.screenY - start.y };
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyResize();
    });
  }, [applyResize]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 执行最后一次 resize，确保拖拽结束时尺寸准确
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      applyResize();
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    cleanup();
  }, [applyResize, cleanup]);

  // 系统抢占 pointer capture 时兜底清理（如触摸被通知中心打断、alt+tab 切换等）
  const handleLostPointerCapture = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      applyResize();
    }
    cleanup();
  }, [applyResize, cleanup]);

  // 底部边缘用 sl/sr 替代 s，中间 50% 留给底部抽屉手柄
  const edges: Edge[] = ['n', 'sl', 'sr', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  if (disabled) return null;

  // block 模式下最大化/全屏时隐藏 resize 手柄
  if ((isMaximized || isFullscreen) && fullscreenMode === 'block') return null;

  return (
    <>
      {edges.map((edge, idx) => (
        <div
          key={edge}
          style={handleStyle(edge)}
          data-name={`component.window-resize-handles.handle-${edge}`}
          data-index={idx + 1}
          data-id={edge}
          onPointerDown={(e) => handlePointerDown(edge, e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onLostPointerCapture={handleLostPointerCapture}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
