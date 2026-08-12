/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层（应用组件选中预览）
   冻结画面绝对定格（Debugger.pause，永不解除）；选中/复制完全由本组件
   （应用 UI）实现：
   - 覆盖层对齐到 webview 元素（ResizeObserver 实时跟随），选中坐标系与
     文本层（guest 视口坐标系）一致 —— 修复选中偏移
   - 拖拽 → 应用渲染高亮矩形（选中预览）
   - 滚轮 → 转发 guest（compositor 滚动画面）+ 累计偏移（文本层跟随）
   - mouseup → 矩形 ∩ 文本层 → 拼文本 → **预览浮层**（不直接复制），
     浮层上「复制」按钮确认后才写入系统剪贴板
   文本层在冻结前由主进程 DOMSnapshot 提取（文档坐标 + 冻结瞬间滚动偏移）。
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

/** 复制预览浮层状态 */
interface ToastState {
  /** 完整选中文本（点复制时使用） */
  text: string;
  title: string;
  preview: string;
  copied: boolean;
}

/** 选中矩形（视口坐标）∩ 文本层（文档坐标 - 偏移）→ 拼接选中文本 */
function computeSelectedText(layer: TextLayer, sel: SelRect, wheelOffsetY: number): string {
  const baseY = layer.scrollOffsetY + wheelOffsetY;
  const hits: Array<{ text: string; y: number; x: number }> = [];
  for (const it of layer.items) {
    const vy = it.y - baseY;
    // x 轴相交
    if (sel.x > it.x + it.w || it.x > sel.x + sel.w) continue;
    // y 轴相交
    if (sel.y > vy + it.h || vy > sel.y + sel.h) continue;
    hits.push({ text: it.text, y: vy, x: it.x });
  }
  // 按文档顺序（y 为主，x 为辅）
  hits.sort((a, b) => a.y - b.y || a.x - b.x);
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
  const [sel, setSel] = useState<SelRect | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [wheelOffsetY, setWheelOffsetY] = useState(0);
  /** 覆盖层对齐 webview 的位置（相对窗口根） */
  const [layerPos, setLayerPos] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; curX: number; curY: number } | null>(null);
  const layerRef = useRef<TextLayer | undefined>(textLayer);
  const wheelRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // 恢复/切换标签时重置选中、滚动偏移与浮层
  useEffect(() => {
    setSel(null);
    setWheelOffsetY(0);
    setToast(null);
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

  // ——— 拖拽选中（mouseup 只预览，不复制）———
  const onMouseDown = (e: React.MouseEvent) => {
    if (state !== 'frozen' || e.button !== 0) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    dragRef.current = { startX: x, startY: y, curX: x, curY: y };
    setSel({ x, y, w: 0, h: 0 });
    setToast(null); // 开始新选择时隐藏旧预览

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !viewportRef.current) return;
      const r = viewportRef.current.getBoundingClientRect();
      d.curX = ev.clientX - r.left;
      d.curY = ev.clientY - r.top;
      setSel({
        x: Math.min(d.startX, d.curX),
        y: Math.min(d.startY, d.curY),
        w: Math.abs(d.curX - d.startX),
        h: Math.abs(d.curY - d.startY),
      });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
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
        setSel(null);
        return;
      }
      const layer = layerRef.current;
      const text = layer ? computeSelectedText(layer, rect, wheelRef.current) : '';
      setSel(null);
      if (text.trim()) {
        // 只预览：显示选中内容，用户点「复制」才写入剪贴板
        const clean = text.trim();
        setToast({
          text: clean,
          title: `选中 ${clean.length} 字`,
          preview: clean.length > 140 ? clean.slice(0, 140) + '…' : clean,
          copied: false,
        });
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        // 未复制 8s 后自动消失
        toastTimerRef.current = setTimeout(() => setToast(null), 8000);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ——— 复制确认 ———
  const onCopyClick = () => {
    if (!toast) return;
    copyFrozenText(toast.text);
    setToast({ ...toast, copied: true });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1500);
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
                // 聚焦选择层：键盘路由回到宿主（Alt+P 走原有拦截链路）
                viewportRef.current?.focus();
                onMouseDown(e);
              }}
              onWheel={onWheel}
            >
              {/* 选中预览高亮（应用渲染） */}
              {sel && (
                <div
                  style={{
                    position: 'absolute',
                    left: sel.x,
                    top: sel.y,
                    width: sel.w,
                    height: sel.h,
                    background: 'rgba(99, 102, 241, 0.28)',
                    border: '1px solid rgba(99, 102, 241, 0.9)',
                    pointerEvents: 'none',
                  }}
                />
              )}
              {/* 选中内容预览浮层（不直接复制，确认后才写入剪贴板） */}
              {toast && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 20,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 10001,
                    maxWidth: '88%',
                    padding: '10px 16px',
                    borderRadius: 10,
                    background: 'rgba(15, 23, 42, 0.95)',
                    color: '#e2e8f0',
                    fontSize: 13,
                    fontFamily: 'var(--font-sans, system-ui)',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: '#a5b4fc' }}>{toast.title}</span>
                    {toast.copied ? (
                      <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ 已复制</span>
                    ) : (
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
                    )}
                  </div>
                  <div
                    style={{
                      opacity: 0.92,
                      maxHeight: 72,
                      overflow: 'hidden',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      lineHeight: 1.5,
                    }}
                  >
                    {toast.preview}
                  </div>
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
