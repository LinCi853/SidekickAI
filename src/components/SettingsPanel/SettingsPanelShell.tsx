/* =====================================================================
   SettingsPanel/SettingsPanelShell.tsx —— 通用侧滑设置面板外壳
   抽离自 index.tsx 的 L112-159（拖拽调宽）+ L378-419（overlay + aside + header）
   两套设置面板（主窗口 + Alt+Q）共享此外壳，保证视觉一致。
   ===================================================================== */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useEscToCloseOverlay } from '../../hooks/useEscToCloseWindow';
import { useUiVersionStore } from '../../store/useUiVersionStore';
import { getOxyLayout } from '../../lib/oxy-design-system';
import { resolveParam, setManualOverride, isManual } from '../../lib/oxy-override-store';
import { OXY_PANELS } from '../../lib/oxy-config';
import '../ui/TitleBar.css'; // 复用毛玻璃风格的 header 背景
import './styles.css';

export interface SettingsPanelShellProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 面板标题（默认"设置"） */
  title?: string;
  /** 面板内容（各 section） */
  children: ReactNode;
  /** 额外 className */
  className?: string;
}

const PANEL_WIDTH_KEY = 'settings-panel-width';
const PANEL_MIN = 300;
const PANEL_MAX = 720;
const DEFAULT_WIDTH = 340;
/** Oxy override key for settings panel width */
const OXY_KEY = 'settingsPanel.width';

export default function SettingsPanelShell({
  open,
  onClose,
  title = '设置',
  children,
  className,
}: SettingsPanelShellProps) {
  const asideRef = useRef<HTMLElement>(null);
  const isOxy = useUiVersionStore((s) => s.version === 'oxy');

  // ESC 关闭设置面板（主窗口用；独立窗口由 useEscToCloseWindow 的 onEsc 拦截后亦触发 onClose，幂等）
  useEscToCloseOverlay(open, onClose);

  // 关闭时设置 inert，防止 Tab 焦点泄漏到隐藏的设置面板
  useEffect(() => {
    if (asideRef.current) {
      if (open) asideRef.current.removeAttribute('inert');
      else asideRef.current.setAttribute('inert', '');
    }
  }, [open]);

  // ===== Oxy 模式 auto 宽度计算 =====
  const computeAutoWidth = useCallback(() => {
    if (typeof window === 'undefined') return DEFAULT_WIDTH;
    const parentW = window.innerWidth;
    return Math.max(
      OXY_PANELS.settings.widthMin,
      Math.min(OXY_PANELS.settings.widthMax, Math.round(parentW * OXY_PANELS.settings.parentRatio)),
    );
  }, []);

  // ===== 面板宽度可调（用户拖拽左边缘） =====
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    // Oxy 模式：检查 manual override
    if (isOxy) {
      if (isManual(OXY_KEY)) {
        return resolveParam(OXY_KEY, computeAutoWidth());
      }
      return computeAutoWidth();
    }
    // Classic 模式：读取 localStorage
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PANEL_WIDTH_KEY) : null;
    const w = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(w) && w >= PANEL_MIN && w <= PANEL_MAX ? w : DEFAULT_WIDTH;
  });
  const draggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // Oxy 模式下窗口 resize 时 auto 宽度跟随
  useEffect(() => {
    if (!isOxy || isManual(OXY_KEY)) return;
    const handler = () => setPanelWidth(computeAutoWidth());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [isOxy, computeAutoWidth]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWRef.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      // 面板在右侧，鼠标向左拖 → 宽度增大
      const delta = dragStartXRef.current - ev.clientX;
      const min = isOxy ? OXY_PANELS.settings.widthMin : PANEL_MIN;
      const max = isOxy ? OXY_PANELS.settings.widthMax : PANEL_MAX;
      const next = Math.max(min, Math.min(max, dragStartWRef.current + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsDragging(false);
      // 持久化
      setPanelWidth((w) => {
        if (isOxy) {
          // Oxy 模式：标记为 manual override
          setManualOverride(OXY_KEY, w);
        } else {
          try { localStorage.setItem(PANEL_WIDTH_KEY, String(w)); } catch { /* ignore */ }
        }
        return w;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, isOxy]);

  return (
    <>
      {/* 遮罩层 */}
      <div
        className={`settings-overlay${open ? ' is-open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
        data-name="settings.overlay"
      />
      {/* 侧滑面板 */}
      <aside
        ref={asideRef}
        className={`settings-panel${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-label={title}
        aria-hidden={!open}
        style={{ width: `${panelWidth}px`, maxWidth: '95vw' }}
        data-name="settings.panel-container"
      >
        {/* 左边缘拖拽条：用户可调节设置面板宽度 */}
        <div
          className={`settings-resize-handle${isDragging ? ' dragging' : ''}`}
          onMouseDown={onHandleMouseDown}
          title="拖拽调节宽度"
          data-name="settings.resize-handle"
        />
        <div className="settings-header" data-name="settings.header">
          <h2 data-name="settings.header-title">{title}</h2>
          <button
            type="button"
            className="settings-close"
            aria-label="关闭"
            onClick={onClose}
            data-name="settings.close-button"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" data-name="settings.close-icon">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <div className="settings-body" data-name="settings.body">
          {children}
        </div>
      </aside>
    </>
  );
}
