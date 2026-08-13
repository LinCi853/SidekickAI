/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层（字符级原生选择）
   冻结画面绝对定格（Debugger.pause，永不解除）；选中由应用组件实现：
   - 文本层在冻结前保存真实 grapheme Range 矩形、行顺序和字体样式
   - host 选择层与 guest visual viewport 建立显式 CSS px 映射
   - anchor/focus 按最近字符边界计算，支持正向、反向、跨行选择
   - 每个选中 run 使用完整原文 + overflow 裁剪，避免从行首复制到中部
   - 高亮只覆盖半透明背景，原字形始终来自冻结底图，杜绝跨 renderer 字体漂移
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useFreezeStore } from '../../store/useFreezeStore';
import { copyFrozenText, scrollFrozenTab, type TextLayer } from '../../lib/electron-api';
import {
  buildSelectedRuns,
  countGraphemes,
  flattenGraphemes,
  getLayerScale,
  nearestAnchorBoundary,
  nearestBoundary,
  selectedText,
  selectGraphemes,
  toGuestPoint,
  type LayerPosition,
  type SelectedRun,
} from './freeze-selection';

interface FreezeOverlayProps {
  activeTabId: string | null;
}

interface ActionBar {
  title: string;
  copied: boolean;
}

export default function FreezeOverlay({ activeTabId }: FreezeOverlayProps) {
  const state = useFreezeStore((s) => (activeTabId ? s.states[activeTabId] : undefined));
  const textLayer = useFreezeStore((s) => (activeTabId ? s.textLayers[activeTabId] : undefined));
  const [showFlash, setShowFlash] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<SelectedRun[]>([]);
  const [selectedTextValue, setSelectedTextValue] = useState('');
  const [actionBar, setActionBar] = useState<ActionBar | null>(null);
  const [layerPos, setLayerPos] = useState<LayerPosition | null>(null);
  const [mappingValid, setMappingValid] = useState(true);
  const wheelRef = useRef({ x: 0, y: 0 });
  const wheelRequestRef = useRef(0);
  const layerRef = useRef<TextLayer | undefined>(textLayer);
  const dragRef = useRef<{ anchor: number; focus: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  layerRef.current = textLayer;

  useEffect(() => {
    if (state !== 'frozen') return;
    setShowFlash(true);
    const timer = setTimeout(() => setShowFlash(false), 1000);
    return () => clearTimeout(timer);
  }, [state, activeTabId]);

  useEffect(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    setSelectedRuns([]);
    setSelectedTextValue('');
    setActionBar(null);
    wheelRef.current = { x: 0, y: 0 };
    wheelRequestRef.current += 1;
    setMappingValid(true);
    dragRef.current = null;
  }, [activeTabId, state]);

  useEffect(() => () => {
    dragCleanupRef.current?.();
    wheelRequestRef.current += 1;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
  }, []);

  useEffect(() => {
    if (state !== 'frozen' || !activeTabId) {
      setLayerPos(null);
      return;
    }
    const align = () => {
      const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
      if (!wv) return;
      const rect = wv.getBoundingClientRect();
      setLayerPos({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    align();
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    const observer = wv && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(align) : null;
    observer?.observe(wv as Element);
    window.addEventListener('resize', align);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', align);
    };
  }, [state, activeTabId]);

  if (state !== 'frozen' && !showFlash) return null;

  const clearActionTimer = () => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = null;
  };

  const applyPointerSelection = (focus: number) => {
    const layer = layerRef.current;
    const drag = dragRef.current;
    if (!layer || !drag) return;
    const flat = flattenGraphemes(layer, wheelRef.current.x, wheelRef.current.y);
    const selected = selectGraphemes(flat, drag.anchor, focus);
    const text = selectedText(selected);
    setSelectedRuns(buildSelectedRuns(layer, selected));
    setSelectedTextValue(text);
    setActionBar(text ? { title: `已选 ${countGraphemes(text)} 字`, copied: false } : null);
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (state !== 'frozen' || event.button !== 0 || !layerPos || !layerRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    viewportRef.current?.focus();
    if (!mappingValid) {
      setActionBar({ title: '当前文本位置不可用', copied: false });
      return;
    }
    const point = toGuestPoint(event.clientX, event.clientY, layerPos, layerRef.current);
    const flat = flattenGraphemes(layerRef.current, wheelRef.current.x, wheelRef.current.y);
    const boundary = nearestAnchorBoundary(flat, point);
    if (boundary === null) {
      setActionBar({ title: '此处没有可选文本', copied: false });
      return;
    }
    dragRef.current = { anchor: boundary, focus: boundary };
    setSelectedRuns([]);
    setSelectedTextValue('');
    setActionBar(null);
    clearActionTimer();
    dragCleanupRef.current?.();

    const onMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current || !layerRef.current || !layerPos) return;
      const p = toGuestPoint(moveEvent.clientX, moveEvent.clientY, layerPos, layerRef.current);
      const currentFlat = flattenGraphemes(layerRef.current, wheelRef.current.x, wheelRef.current.y);
      dragRef.current.focus = nearestBoundary(currentFlat, p);
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (dragRef.current) applyPointerSelection(dragRef.current.focus);
      });
    };
    const onUp = () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (dragRef.current) applyPointerSelection(dragRef.current.focus);
      dragRef.current = null;
      clearActionTimer();
      actionTimerRef.current = setTimeout(() => setActionBar(null), 8000);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    dragCleanupRef.current = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  };

  const onCopyClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedTextValue) return;
    copyFrozenText(selectedTextValue);
    setActionBar({ title: `已选 ${countGraphemes(selectedTextValue)} 字`, copied: true });
    clearActionTimer();
    actionTimerRef.current = setTimeout(() => {
      setActionBar(null);
      setSelectedRuns([]);
      setSelectedTextValue('');
    }, 1500);
  };

  const onWheel = (event: React.WheelEvent) => {
    if (state !== 'frozen' || !activeTabId || !layerPos || !layerRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const layer = layerRef.current;
    const point = toGuestPoint(event.clientX, event.clientY, layerPos, layer);
    const scale = getLayerScale(layer, layerPos);
    const dx = event.deltaX / scale.x;
    const dy = event.deltaY / scale.y;
    const before = wheelRef.current;
    const requestId = ++wheelRequestRef.current;
    const optimistic = {
      x: before.x + dx,
      y: before.y + dy,
    };
    wheelRef.current = optimistic;
    setMappingValid(false);
    void scrollFrozenTab(activeTabId, point.x, point.y, dx, dy).then((result) => {
      if (wheelRequestRef.current !== requestId) return;
      if (!result) {
        setMappingValid(false);
        return;
      }
      const maxX = Math.max(0, layer.contentWidth - layer.viewportWidth);
      const maxY = Math.max(0, layer.contentHeight - layer.viewportHeight);
      const expectedX = Math.min(maxX, Math.max(0, layer.scrollOffsetX + optimistic.x));
      const expectedY = Math.min(maxY, Math.max(0, layer.scrollOffsetY + optimistic.y));
      const previousX = layer.scrollOffsetX + before.x;
      const previousY = layer.scrollOffsetY + before.y;
      const requestedRootMovement = Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1;
      const rootUnchanged = Math.abs(result.scrollOffsetX - previousX) <= 0.5
        && Math.abs(result.scrollOffsetY - previousY) <= 0.5;
      if (requestedRootMovement && rootUnchanged) {
        setMappingValid(false);
        return;
      }
      const rootMoved = Math.abs(result.scrollOffsetX - layer.scrollOffsetX) > 0.5
        || Math.abs(result.scrollOffsetY - layer.scrollOffsetY) > 0.5;
      if (rootMoved && layer.items.some((item) => item.sticky)) {
        setMappingValid(false);
        return;
      }
      if (Math.abs(result.scrollOffsetX - expectedX) > 2 || Math.abs(result.scrollOffsetY - expectedY) > 2) {
        setMappingValid(false);
        return;
      }
      wheelRef.current = {
        x: result.scrollOffsetX - layer.scrollOffsetX,
        y: result.scrollOffsetY - layer.scrollOffsetY,
      };
      setMappingValid(true);
    });
    setSelectedRuns([]);
    setSelectedTextValue('');
    setActionBar(null);
  };

  const layer = layerRef.current;
  const scale = layer && layerPos ? getLayerScale(layer, layerPos) : { x: 1, y: 1 };

  return (
    <>
      {showFlash && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(99,102,241,.35)', pointerEvents: 'none', animation: 'freeze-flash 1s ease-out forwards' }} />
      )}
      {state === 'frozen' && (
        <>
          <div
            className="freeze-border-indicator"
            data-name="browser.freeze-border"
            style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9998, boxShadow: 'inset 0 0 0 3px rgba(99,102,241,.8)', animation: 'freeze-breath 2s ease-in-out infinite' }}
          />
          {layerPos && layer && (
            <div
              ref={viewportRef}
              className="freeze-selection-layer"
              data-name="browser.freeze-selection"
              tabIndex={0}
              style={{ position: 'fixed', left: layerPos.left, top: layerPos.top, width: layerPos.width, height: layerPos.height, zIndex: 9999, cursor: 'text', touchAction: 'none', userSelect: 'none', outline: 'none' }}
              onMouseDown={onMouseDown}
              onWheel={onWheel}
            >
              {selectedRuns.map((run, index) => {
                const left = run.startX * scale.x;
                const top = run.y * scale.y;
                const width = Math.max(1, (run.endX - run.startX) * scale.x);
                const height = Math.max(1, run.h * scale.y);
                return (
                  <div
                    key={`${run.itemIndex}-${index}`}
                    style={{ position: 'absolute', left, top, width, height, background: 'rgba(0,120,215,.42)', pointerEvents: 'none' }}
                  />
                );
              })}
              {actionBar && (
                <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderRadius: 8, background: 'rgba(15,23,42,.92)', color: '#e2e8f0', fontSize: 13, fontFamily: 'var(--font-sans,system-ui)', boxShadow: '0 4px 16px rgba(0,0,0,.35)', whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 600, color: '#a5b4fc' }}>{actionBar.title}</span>
                  {actionBar.copied ? <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ 已复制</span> : selectedTextValue && <button onMouseDown={(e) => e.stopPropagation()} onClick={onCopyClick} style={{ border: '1px solid rgba(165,180,252,.5)', background: 'rgba(99,102,241,.25)', color: '#e0e7ff', padding: '2px 12px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>复制</button>}
                </div>
              )}
            </div>
          )}
          <style>{`@keyframes freeze-breath {0%,100%{box-shadow:inset 0 0 0 3px rgba(99,102,241,.5)}50%{box-shadow:inset 0 0 0 3px rgba(99,102,241,.9)}}@keyframes freeze-flash {0%{opacity:1}100%{opacity:0}}`}</style>
        </>
      )}
    </>
  );
}
