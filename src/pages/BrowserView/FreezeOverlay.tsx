/* =====================================================================
   pages/BrowserView/FreezeOverlay.tsx —— 冻结态覆盖层（应用组件选中复制）
   冻结画面绝对定格（Debugger.pause，永不解除）；选中/复制完全由本组件
   （应用 UI）实现：
   - 覆盖层拦截鼠标/滚轮（宿主层），页面不再接收任何物理输入
   - 拖拽 → 应用渲染高亮矩形（选中预览）
   - 滚轮 → 转发 guest（compositor 滚动画面）+ 累计偏移（文本层跟随）
   - mouseup → 矩形 ∩ 文本层 → 拼文本 → 主进程写剪贴板 → "已复制 N 字"浮层
   文本层在冻结前由主进程 DOMSnapshot 提取（文档坐标 + 冻结瞬间滚动偏移），
   视口坐标 = 文档坐标 - (冻结时偏移 + 用户滚轮累计)。
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
  const [toast, setToast] = useState<string | null>(null);
  const [wheelOffsetY, setWheelOffsetY] = useState(0);

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

  // 恢复/切换标签时重置选中与滚动偏移
  useEffect(() => {
    setSel(null);
    setWheelOffsetY(0);
    dragRef.current = null;
  }, [activeTabId, state]);

  if (state !== 'frozen' && !showFlash) return null;

  // ——— 拖拽选中 ———
  const onMouseDown = (e: React.MouseEvent) => {
    if (state !== 'frozen' || e.button !== 0) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    dragRef.current = { startX: x, startY: y, curX: x, curY: y };
    setSel({ x, y, w: 0, h: 0 });

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
      // 单击（无有效拖拽）不复制
      if (rect.w < 3 || rect.h < 3) {
        setSel(null);
        return;
      }
      const layer = layerRef.current;
      const text = layer ? computeSelectedText(layer, rect, wheelRef.current) : '';
      setSel(null);
      if (text.trim()) {
        copyFrozenText(text);
        setToast(`已复制 ${text.trim().length} 字`);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 1800);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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

          {/* 选择层：拦截输入（画面绝对定格），拖拽选中 + 滚轮转发（应用组件） */}
          <div
            ref={viewportRef}
            className="freeze-selection-layer"
            data-name="browser.freeze-selection"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 9999,
              cursor: 'text',
              touchAction: 'none',
              userSelect: 'none',
            }}
            onMouseDown={onMouseDown}
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
            {/* 复制结果浮层（预览反馈） */}
            {toast && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 28,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 10001,
                  padding: '7px 16px',
                  borderRadius: 8,
                  background: 'rgba(15, 23, 42, 0.92)',
                  color: '#e2e8f0',
                  fontSize: 13,
                  fontFamily: 'var(--font-sans, system-ui)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                  pointerEvents: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {toast}
              </div>
            )}
          </div>

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
