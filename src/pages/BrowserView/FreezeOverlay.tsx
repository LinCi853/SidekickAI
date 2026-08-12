/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层（原生样式文本选择）
   冻结画面绝对定格（Debugger.pause，永不解除）；选中由应用组件实现，
   样式接近原生 selection：
   - 文本层 = 冻结前行盒提取（Range.getClientRects 每行精确盒 + 页面字体
     样式 + canvas 按宽度切分每行文本 → 自动换行识别）
   - 拖拽中实时原位高亮：命中行盒渲染「原生蓝底 + 同字体白字副本」，
     副本用页面同一字体渲染，与原文字形完全重叠 → 反色效果无错位，
     不同字号行各自精确
   - 滚轮 → 转发 guest 滚动 + 偏移跟随
   - mouseup → 操作条「已选 N 字 [复制]」确认复制（行间 \n 拼接）
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import { useFreezeStore } from '../../store/useFreezeStore';
import { copyFrozenText, scrollFrozenTab, type TextLayer } from '../../lib/electron-api';

interface FreezeOverlayProps {
  /** 当前激活标签 id */
  activeTabId: string | null;
}

interface SelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 命中行盒（视口坐标 + 字体样式，供原生样式渲染） */
interface HitItem {
  text: string;
  vx: number;
  vy: number;
  w: number;
  h: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
}

/** 操作条状态 */
interface ActionBar {
  title: string;
  copied: boolean;
}

/**
 * 选中矩形（视口坐标）∩ 文本层行盒（文档坐标 - 偏移）→ 命中项（视口坐标）。
 * 行盒级裁剪：高亮块 = 行盒 ∩ 选中矩形的 x 方向交集（精确位置/大小），
 * 文本按宽度比例截取子串（行文本已由 canvas 精确切分，换行正确）。
 */
function computeHitItems(layer: TextLayer, sel: SelRect, wheelOffsetY: number): HitItem[] {
  const baseY = layer.scrollOffsetY + wheelOffsetY;
  const hits: HitItem[] = [];
  for (const it of layer.items) {
    const vy = it.y - baseY;
    // y 轴相交（行盒整行高亮，同原生 selection）
    if (sel.y > vy + it.h || vy > sel.y + sel.h) continue;
    // x 轴裁剪：高亮块 = 行盒 ∩ 选中矩形
    const hl = Math.max(it.x, sel.x);
    const hr = Math.min(it.x + it.w, sel.x + sel.w);
    const hw = hr - hl;
    if (hw <= 0) continue;
    // 按宽度比例截取子串
    const ratio = hw / it.w;
    const n = Math.max(1, Math.round(it.text.length * ratio));
    hits.push({
      text: it.text.slice(0, n),
      vx: hl,
      vy,
      w: hw,
      h: it.h,
      fontSize: it.fontSize,
      fontFamily: it.fontFamily,
      fontWeight: it.fontWeight,
    });
  }
  // 按文档顺序（y 为主，x 为辅）
  hits.sort((a, b) => a.vy - b.vy || a.vx - b.vx);
  return hits;
}

/** 命中项 → 完整选中文本（每行 \n 拼接，自动换行） */
function hitsToText(hits: HitItem[]): string {
  return hits
    .map((h) => h.text.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export default function FreezeOverlay({ activeTabId }: FreezeOverlayProps) {
  const state = useFreezeStore((s) => (activeTabId ? s.states[activeTabId] : undefined));
  const textLayer = useFreezeStore((s) => (activeTabId ? s.textLayers[activeTabId] : undefined));
  const [showFlash, setShowFlash] = useState(false);
  /** 实时命中项（拖拽中 + mouseup 后） */
  const [selItems, setSelItems] = useState<HitItem[] | null>(null);
  const [actionBar, setActionBar] = useState<ActionBar | null>(null);
  const [wheelOffsetY, setWheelOffsetY] = useState(0);
  /** 覆盖层对齐 webview 的位置（相对窗口根） */
  const [layerPos, setLayerPos] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const layerRef = useRef<TextLayer | undefined>(textLayer);
  const wheelRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  layerRef.current = textLayer;
  wheelRef.current = wheelOffsetY;

  // 冻结瞬间 1 秒全屏闪烁（视觉提示）
  useEffect(() => {
    if (state === 'frozen') {
      setShowFlash(true);
      const t = setTimeout(() => setShowFlash(false), 1000);
      return () => clearTimeout(t);
    }
  }, [state, activeTabId]);

  // 恢复/切换标签时重置全部状态
  useEffect(() => {
    setSelItems(null);
    setActionBar(null);
    setWheelOffsetY(0);
    dragRef.current = null;
  }, [activeTabId, state]);

  // 覆盖层对齐到 webview 元素：选中坐标系 = guest 视口坐标系（与文本层一致）
  useEffect(() => {
    if (state !== 'frozen' || !activeTabId) {
      setLayerPos(null);
      return;
    }
    const align = () => {
      const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
      if (!wv) return;
      const r = wv.getBoundingClientRect();
      setLayerPos({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    align();
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as HTMLElement | null;
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && wv) {
      ro = new ResizeObserver(align);
      ro.observe(wv);
    }
    window.addEventListener('resize', align);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', align);
    };
  }, [state, activeTabId]);

  if (state !== 'frozen' && !showFlash) return null;

  // ——— 按当前拖拽矩形计算命中项（拖拽实时 + mouseup 共用）———
  const applySelection = (d: { startX: number; startY: number; curX: number; curY: number }) => {
    const rect = {
      x: Math.min(d.startX, d.curX),
      y: Math.min(d.startY, d.curY),
      w: Math.abs(d.curX - d.startX),
      h: Math.abs(d.curY - d.startY),
    };
    // 单击（无有效拖拽）不清除
    if (rect.w < 3 || rect.h < 3) return;
    const layer = layerRef.current;
    if (!layer || layer.items.length === 0) return;
    setSelItems(computeHitItems(layer, rect, wheelRef.current));
  };

  // ——— 拖拽选中（实时原位高亮，原生样式）———
  const onMouseDown = (e: React.MouseEvent) => {
    if (state !== 'frozen' || e.button !== 0) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    dragRef.current = { startX: x, startY: y, curX: x, curY: y };
    // 开始新选择时清除旧选中与操作条
    setSelItems(null);
    setActionBar(null);

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !viewportRef.current) return;
      const r = viewportRef.current.getBoundingClientRect();
      d.curX = ev.clientX - r.left;
      d.curY = ev.clientY - r.top;
      // rAF 节流：拖拽中实时计算命中（原生 selection 感）
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const cur = dragRef.current;
        if (cur) applySelection(cur);
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      const rect = {
        x: Math.min(d.startX, d.curX),
        y: Math.min(d.startY, d.curY),
        w: Math.abs(d.curX - d.startX),
        h: Math.abs(d.curY - d.startY),
      };
      // 单击（无有效拖拽）不预览
      if (rect.w < 3 || rect.h < 3) {
        setSelItems(null);
        return;
      }
      const layer = layerRef.current;
      if (!layer || layer.items.length === 0) {
        // 诊断：文本层为空（未提取到页面文本）
        setSelItems(null);
        setActionBar({ title: '未提取到页面文本，无法选中', copied: false });
        return;
      }
      const hits = computeHitItems(layer, rect, wheelRef.current);
      const text = hitsToText(hits);
      if (!text.trim()) {
        setSelItems(null);
        setActionBar({ title: '选中区域无文本', copied: false });
        return;
      }
      setSelItems(hits);
      setActionBar({ title: `已选 ${text.trim().length} 字`, copied: false });
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      // 8s 后操作条消失（原位高亮保留）
      actionTimerRef.current = setTimeout(() => setActionBar(null), 8000);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ——— 复制确认 ———
  const onCopyClick = () => {
    const hits = selItems;
    if (!hits) return;
    const text = hitsToText(hits);
    if (!text.trim()) return;
    copyFrozenText(text);
    setActionBar({ title: `已选 ${text.trim().length} 字`, copied: true });
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(() => {
      setActionBar(null);
      setSelItems(null);
    }, 1500);
  };

  // ——— 滚轮：转发 guest 滚动画面 + 累计偏移 ———
  const onWheel = (e: React.WheelEvent) => {
    if (state !== 'frozen') return;
    e.preventDefault();
    const layer = layerRef.current;
    if (!layer) return;
    const vh = viewportRef.current?.clientHeight ?? 300;
    const maxOffset = Math.max(0, layer.contentHeight - vh);
    const next = Math.min(maxOffset, Math.max(0, wheelRef.current + e.deltaY));
    const real = next - wheelRef.current;
    if (Math.abs(real) > 0.5) {
      scrollFrozenTab(activeTabId!, e.deltaX, real);
      setWheelOffsetY(next);
      // 滚动后原位高亮位置失效，清除
      setSelItems(null);
      setActionBar(null);
    }
  };

  return (
    <>
      {/* 冻结瞬间全屏遮罩（1 秒闪烁提示） */}
      {showFlash && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(99, 102, 241, 0.35)',
            pointerEvents: 'none',
            animation: 'freeze-flash 1s ease-out forwards',
          }}
        />
      )}

      {state === 'frozen' && (
        <>
          {/* 冻结态边框指示器（蓝色呼吸光，纯视觉） */}
          <div
            className="freeze-border-indicator"
            data-name="browser.freeze-border"
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              zIndex: 9998,
              boxShadow: 'inset 0 0 0 3px rgba(99, 102, 241, 0.8)',
              animation: 'freeze-breath 2s ease-in-out infinite',
            }}
          />

          {/* 选择层：对齐 webview（坐标系与文本层一致），拦截输入、拖拽选中 + 滚轮转发 */}
          {layerPos && (
            <div
              ref={viewportRef}
              className="freeze-selection-layer"
              data-name="browser.freeze-selection"
              tabIndex={0}
              style={{
                position: 'absolute',
                left: layerPos.left,
                top: layerPos.top,
                width: layerPos.width,
                height: layerPos.height,
                zIndex: 9999,
                cursor: 'text',
                touchAction: 'none',
                userSelect: 'none',
                outline: 'none',
              }}
              onMouseDown={(e) => {
                // 聚焦选择层：键盘路由回到宿主（宿主已挂 Alt+P 拦截）
                viewportRef.current?.focus();
                onMouseDown(e);
              }}
              onWheel={onWheel}
            >
              {/* 原生样式选中：蓝底 + 同字体白字副本（与原文字形重叠） */}
              {selItems &&
                selItems.map((it, i) => (
                  <div
                    key={i}
                    style={{
                      position: 'absolute',
                      left: it.vx,
                      top: it.vy,
                      width: it.w,
                      height: it.h,
                      background: 'rgba(0, 120, 215, 0.9)',
                      color: '#fff',
                      fontSize: it.fontSize ?? it.h,
                      fontFamily: it.fontFamily || 'sans-serif',
                      fontWeight: it.fontWeight || '400',
                      lineHeight: it.h + 'px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      pointerEvents: 'none',
                      userSelect: 'none',
                      textAlign: 'left',
                      boxSizing: 'border-box',
                      padding: 0,
                      margin: 0,
                    }}
                  >
                    {it.text}
                  </div>
                ))}

              {/* 操作条：已选字数 + 复制确认 */}
              {actionBar && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 20,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 10001,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 14px',
                    borderRadius: 8,
                    background: 'rgba(15, 23, 42, 0.92)',
                    color: '#e2e8f0',
                    fontSize: 13,
                    fontFamily: 'var(--font-sans, system-ui)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#a5b4fc' }}>{actionBar.title}</span>
                  {actionBar.copied ? (
                    <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ 已复制</span>
                  ) : (
                    selItems && (
                      <button
                        onClick={onCopyClick}
                        style={{
                          border: '1px solid rgba(165, 180, 252, 0.5)',
                          background: 'rgba(99, 102, 241, 0.25)',
                          color: '#e0e7ff',
                          padding: '2px 12px',
                          borderRadius: 5,
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        复制
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          <style>{`
            @keyframes freeze-breath {
              0%, 100% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.5); }
              50% { box-shadow: inset 0 0 0 3px rgba(99, 102, 241, 0.9); }
            }
            @keyframes freeze-flash {
              0% { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
        </>
      )}
    </>
  );
}
