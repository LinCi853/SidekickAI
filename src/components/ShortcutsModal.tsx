/* =====================================================================
   components/ShortcutsModal.tsx —— 快捷键查看弹窗
   点击底栏「快捷键」按钮打开，展示所有可用快捷键。
   关键设计：使用 CSS grid 三段式布局（hotkey | action | scope badge），
   兼容窄窗口（QQ 风格窄长窗口下也不会把中文挤成竖排）。

   前 3 项（全局热键）支持动态化：通过 hotkeys prop 反映用户自定义的 accelerator
   与启用状态。已禁用的热键以灰显样式标记。后 12 项（窗口内 / 应用内）保持硬编码。
   ===================================================================== */

import './ShortcutsModal.css';
import type { HotkeyConfig, HotkeyAction } from '../lib/electron-api';
import { IconButton } from './ui';

export interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
  /** 当前全局热键配置（动态渲染前 3 项；不传则用默认值） */
  hotkeys?: HotkeyConfig[];
}

/** 前 3 项全局热键的默认配置（hotkeys prop 缺失时使用） */
const DEFAULT_GLOBAL_HOTKEYS: Array<{
  action: HotkeyAction;
  fallbackKeys: string;
  actionText: string;
  note?: string;
}> = [
  { action: 'toggleMainWindow', fallbackKeys: 'Alt + Space', actionText: '呼出/隐藏主窗口' },
  { action: 'toggleDetachedWindows', fallbackKeys: 'Alt + Q', actionText: '打开 AI 应用管理窗口' },
  { action: 'backgroundVoice', fallbackKeys: 'Alt + V', actionText: '后台语音录入（按住说话，松开发送）' },
];

/** 应用内 / 窗口内快捷键（保持硬编码） */
const APP_SHORTCUTS: Array<{ keys: string; action: string; scope: string; note?: string }> = [
  { keys: 'Alt + 1~9', action: '切换到第 N 个标签', scope: '窗口内' },
  { keys: 'Ctrl + Tab / Ctrl + Shift + Tab', action: '向前/向后循环切换标签', scope: '窗口内' },
  { keys: 'Ctrl + T', action: '脱离当前标签为独立窗口', scope: '窗口内' },
  { keys: 'Ctrl + W', action: '关闭当前标签', scope: '窗口内' },
  { keys: '双击标题', action: '编辑标签标题', scope: '窗口内' },
  { keys: 'F4', action: '后退（当前标签）', scope: '应用内' },
  { keys: 'F5', action: '刷新当前标签', scope: '应用内' },
  { keys: 'F6', action: '前进（当前标签）', scope: '应用内' },
  { keys: 'F10', action: '切换主题', scope: '应用内' },
  { keys: 'F11', action: '窗口最大化/还原', scope: '应用内', note: '与置顶互斥，进入时自动取消置顶' },
  { keys: 'F12', action: '切换当前窗口置顶', scope: '应用内', note: '最大化/全屏时不可用' },
  { keys: 'Ctrl + G', action: '切换手柄/键盘空间导航', scope: '应用内' },
  { keys: '` / ~ / ?', action: '呼出/关闭快捷键说明窗口', scope: '应用内' },
];

/** accelerator 'Alt+Space' → 'Alt + Space'（统一展示格式） */
function formatAcc(acc: string): string {
  return acc
    .split('+')
    .map((p) => p.trim())
    .join(' + ');
}

/** 范围文本 → badge 颜色 class（视觉区隔） */
function scopeClass(scope: string): string {
  if (scope === '全局') return 'shortcuts-scope-badge is-global';
  if (scope === '窗口内') return 'shortcuts-scope-badge is-window';
  return 'shortcuts-scope-badge is-app';
}

export default function ShortcutsModal({ open, onClose, hotkeys }: ShortcutsModalProps) {
  // 前 3 项：根据 hotkeys prop 动态生成（自定义 accelerator + 启用状态）
  const globalItems = DEFAULT_GLOBAL_HOTKEYS.map((g) => {
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
