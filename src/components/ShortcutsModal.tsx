/* =====================================================================
   components/ShortcutsModal.tsx —— 快捷键查看弹窗
   点击底栏「快捷键」按钮打开，展示所有可用快捷键。
   关键设计：使用 CSS grid 三段式布局（hotkey | action | scope badge），
   兼容窄窗口（QQ 风格窄长窗口下也不会把中文挤成竖排）。

   前 3 项（全局热键）支持动态化：通过 hotkeys prop 反映用户自定义的 accelerator
   与启用状态。已禁用的热键以灰显样式标记。全部静态数据来自
   lib/shortcut-reference.ts（与使用指南共享的单一事实来源）。
   ===================================================================== */

import './ShortcutsModal.css';
import type { HotkeyConfig } from '../lib/electron-api';
import { IconButton } from './ui';
import { useEscToCloseOverlay } from '../hooks/useEscToCloseWindow';
import { GLOBAL_HOTKEY_META, APP_SHORTCUTS, formatAcc } from '../lib/shortcut-reference';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  /** 当前全局热键配置（动态渲染前 3 项；不传则用默认值） */
  hotkeys?: HotkeyConfig[];
}

/** 范围文本 → badge 颜色 class（视觉区隔） */
function scopeClass(scope: string): string {
  if (scope === '全局') return 'shortcuts-scope-badge is-global';
  if (scope === '窗口内') return 'shortcuts-scope-badge is-window';
  return 'shortcuts-scope-badge is-app';
}

export default function ShortcutsModal({ open, onClose, hotkeys }: ShortcutsModalProps) {
  // ESC 关闭快捷键说明面板
  useEscToCloseOverlay(open, onClose);

  // 前 3 项：根据 hotkeys prop 动态生成（自定义 accelerator + 启用状态）
  const globalItems = GLOBAL_HOTKEY_META.map((g) => {
    const cfg = hotkeys?.find((h) => h.action === g.action);
    const keys = cfg ? formatAcc(cfg.accelerator) : g.fallbackKeys;
    const enabled = cfg?.enabled ?? true;
    return {
      keys,
      action: g.actionText,
      scope: '全局',
      note: g.note,
      disabled: !enabled,
    };
  });

  // 后 12 项：硬编码应用内 / 窗口内快捷键
  const appItems = APP_SHORTCUTS.map((s) => ({ ...s, disabled: false }));

  const allItems = [...globalItems, ...appItems];

  return (
    <div
      className={`shortcuts-overlay${open ? ' is-open' : ''}`}
      data-name="component.shortcuts-modal.overlay"
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-label="快捷键"
        data-name="component.shortcuts-modal.modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-header" data-name="component.shortcuts-modal.modal-header">
          <h2 data-name="component.shortcuts-modal.title">快捷键</h2>
          <IconButton
            type="button"
            variant="close"
            className="shortcuts-close"
            data-name="component.shortcuts-modal.close-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <svg
              className="icon-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              data-name="component.shortcuts-modal.close-icon"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </IconButton>
        </div>
        <div className="shortcuts-body" data-name="component.shortcuts-modal.modal-body">
          <div className="shortcuts-list" role="list" data-name="component.shortcuts-modal.list">
            {allItems.map((s, idx) => (
              <div
                className={`shortcuts-item${s.disabled ? ' is-disabled' : ''}`}
                role="listitem"
                key={`${s.keys}-${idx}`}
                data-name={`component.shortcuts-modal.item-${idx + 1}`}
                data-index={idx + 1}
                data-id={s.keys}
              >
                <div className="shortcuts-keys" data-name={`component.shortcuts-modal.item-keys-${idx + 1}`}>{s.keys}</div>
                <div className="shortcuts-action" data-name={`component.shortcuts-modal.item-action-${idx + 1}`}>
                  <span className="shortcuts-action-text" data-name={`component.shortcuts-modal.item-action-text-${idx + 1}`}>
                    {s.action}
                    {s.disabled && <span className="shortcuts-disabled-tag" data-name={`component.shortcuts-modal.item-disabled-tag-${idx + 1}`}>（已禁用）</span>}
                  </span>
                  {s.note && <div className="shortcuts-note" data-name={`component.shortcuts-modal.item-note-${idx + 1}`}>{s.note}</div>}
                </div>
                <div className="shortcuts-scope" data-name={`component.shortcuts-modal.item-scope-${idx + 1}`}>
                  <span className={scopeClass(s.scope)} data-name={`component.shortcuts-modal.item-scope-badge-${idx + 1}`}>{s.scope}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
