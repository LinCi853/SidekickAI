/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层（字符级原生选择）
   冻结画面绝对定格（Debugger.pause，永不解除）；选中由应用组件实现：
   - 文本层在冻结前保存真实 grapheme Range 矩形与行顺序
   - host 选择层与 guest visual viewport 建立显式 CSS px 映射
   - anchor/focus 按最近字符边界计算，支持正向、反向、跨行选择
   - 复制始终按 DOM/grapheme 顺序拼接，高亮按视觉 run 分段
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
  getTextLayerQuality,
  isTextLayerSelectable,
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

interface ScrollState {
  x: number;
  y: number;
  valid: boolean;
}

const scrollByTab = new Map<string, ScrollState & { layer: TextLayer }>();

export default function FreezeOverlay({ activeTabId }: FreezeOverlayProps) {
  const state = useFreezeStore((s) => (activeTabId ? s.states[activeTabId] : undefined));
  const revision = useFreezeStore((s) => (activeTabId ? s.revisions[activeTabId] : undefined));
  const textLayer = useFreezeStore((s) => (activeTabId ? s.textLayers[activeTabId] : undefined));
  const [showFlash, setShowFlash] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<SelectedRun[]>([]);
  const [selectedTextValue, setSelectedTextValue] = useState('');
  const [actionBar, setActionBar] = useState<ActionBar | null>(null);
  const [layerPos, setLayerPos] = useState<LayerPosition | null>(null);
  const [mappingValid, setMappingValid] = useState(true);
  const wheelRef = useRef<ScrollState>({ x: 0, y: 0, valid: true });
  const wheelRequestRef = useRef(0);
  const pendingWheelRef = useRef({ x: 0, y: 0 });
  const wheelInFlightRef = useRef<number | null>(null);
  const layerRef = useRef<TextLayer | undefined>(textLayer);
  const dragRef = useRef<{ anchor: number; focus: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const sessionKey = activeTabId ? `${activeTabId}:${revision ?? 0}` : '';
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
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
    const saved = activeTabId ? scrollByTab.get(activeTabId) : undefined;
    const currentSaved = saved?.layer === textLayer ? saved : undefined;
    wheelRef.current = currentSaved ?? { x: 0, y: 0, valid: true };
    wheelRequestRef.current += 1;
    pendingWheelRef.current = { x: 0, y: 0 };
    wheelInFlightRef.current = null;
    setMappingValid(currentSaved?.valid ?? true);
    dragRef.current = null;
  }, [activeTabId, revision, state, textLayer]);

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
    const quality = getTextLayerQuality(layerRef.current);
    if (quality === 'none') {
      setActionBar({ title: '当前页面无文本内容', copied: false });
      clearActionTimer();
      actionTimerRef.current = setTimeout(() => setActionBar(null), 2200);
      return;
    }
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
    const scrollKey = sessionKey;
    const point = toGuestPoint(event.clientX, event.clientY, layerPos, layer);
    const nestedRegion = layer.nestedScrollRegions.find((region) => (
      point.x >= region.x
      && point.x <= region.x + region.w
      && point.y >= region.y
      && point.y <= region.y + region.h
    ));
    if (nestedRegion) {
      setActionBar({ title: '此区域冻结后不可滚动', copied: false });
      clearActionTimer();
      actionTimerRef.current = setTimeout(() => setActionBar(null), 2200);
      return;
    }
    const scale = getLayerScale(layer, layerPos);
    const dx = event.deltaX / scale.x;
    const dy = event.deltaY / scale.y;
    const before = wheelRef.current;
    const optimistic = {
      x: before.x + dx,
      y: before.y + dy,
      valid: false,
    };
    wheelRef.current = optimistic;
    scrollByTab.set(activeTabId, { ...optimistic, layer });
    pendingWheelRef.current.x += dx;
    pendingWheelRef.current.y += dy;
    setMappingValid(false);
    const flushWheel = async () => {
      const generation = wheelRequestRef.current;
      const requestSessionKey = scrollKey;
      if (wheelInFlightRef.current !== null || !activeTabId) return;
      wheelInFlightRef.current = generation;
      try {
        while (Math.abs(pendingWheelRef.current.x) > 0.01 || Math.abs(pendingWheelRef.current.y) > 0.01) {
          if (wheelRequestRef.current !== generation || sessionKeyRef.current !== requestSessionKey) break;
          const pending = pendingWheelRef.current;
          pendingWheelRef.current = { x: 0, y: 0 };
          const result = await scrollFrozenTab(activeTabId, point.x, point.y, pending.x, pending.y);
          if (wheelRequestRef.current !== generation
            || sessionKeyRef.current !== requestSessionKey
            || !layerRef.current) break;
          const currentLayer = layerRef.current;
          if (!result) {
            wheelRef.current.valid = false;
            scrollByTab.set(activeTabId, { ...wheelRef.current, layer: currentLayer });
            setMappingValid(false);
            break;
          }
          const maxX = Math.max(0, currentLayer.contentWidth - currentLayer.viewportWidth);
          const maxY = Math.max(0, currentLayer.contentHeight - currentLayer.viewportHeight);
          const expectedX = Math.min(maxX, Math.max(0, currentLayer.scrollOffsetX + wheelRef.current.x));
          const expectedY = Math.min(maxY, Math.max(0, currentLayer.scrollOffsetY + wheelRef.current.y));
          const rootMoved = Math.abs(result.scrollOffsetX - currentLayer.scrollOffsetX) > 0.5
            || Math.abs(result.scrollOffsetY - currentLayer.scrollOffsetY) > 0.5;
          if (rootMoved && currentLayer.items.some((item) => item.sticky)) {
            wheelRef.current.valid = false;
            scrollByTab.set(activeTabId, { ...wheelRef.current, layer: currentLayer });
            setMappingValid(false);
            break;
          }
          if (Math.abs(result.scrollOffsetX - expectedX) > 2 || Math.abs(result.scrollOffsetY - expectedY) > 2) {
            wheelRef.current.valid = false;
            scrollByTab.set(activeTabId, { ...wheelRef.current, layer: currentLayer });
            setMappingValid(false);
            break;
          }
          wheelRef.current = {
            x: result.scrollOffsetX - currentLayer.scrollOffsetX,
            y: result.scrollOffsetY - currentLayer.scrollOffsetY,
            valid: true,
          };
          scrollByTab.set(activeTabId, { ...wheelRef.current, layer: currentLayer });
          setMappingValid(true);
        }
      } finally {
        if (wheelInFlightRef.current === generation) wheelInFlightRef.current = null;
      }
      if (wheelRequestRef.current === generation
        && sessionKeyRef.current === requestSessionKey
        && (Math.abs(pendingWheelRef.current.x) > 0.01 || Math.abs(pendingWheelRef.current.y) > 0.01)) {
        void flushWheel();
      }
    };
    void flushWheel();
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
                style={{ position: 'fixed', left: layerPos.left, top: layerPos.top, width: layerPos.width, height: layerPos.height, zIndex: 9999, cursor: getTextLayerQuality(layer) !== 'none' ? 'text' : 'default', touchAction: 'none', userSelect: 'none', outline: 'none' }}
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
