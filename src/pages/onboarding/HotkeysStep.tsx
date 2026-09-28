/* =====================================================================
   pages/onboarding/HotkeysStep.tsx —— 引导页 3：上手动作
   职责：3 个全局热键动态显示与启停（Alt+Space / Alt+Q / Alt+V，可在设置中自定义）
   + 高频窗口操作速查，平铺三段式行布局与 ShortcutsModal 视觉一致；
   完整速查指向 ` 呼出的 ShortcutsModal。
   快捷键静态数据与 ShortcutsModal 共享 lib/shortcut-reference.ts，避免双维护。
   从 pages/OnboardingView.tsx 拆出，仅通过 props 回调操作状态，不改变任何行为。
   ===================================================================== */

import type { HotkeyConfig } from '../../lib/electron-api';
import { Toggle } from '../../components/ui';
import { APP_SHORTCUTS, GLOBAL_HOTKEY_META, ONBOARDING_SHORTCUT_KEYS } from '../../lib/shortcut-reference';
import { resolveHotkey } from './onboardingData';

interface HotkeysStepProps {
  hotkeys: HotkeyConfig[];
  onToggleMainHotkey: (next: boolean) => Promise<void>;
  onTogglePanelHotkey: (next: boolean) => Promise<void>;
  onToggleVoiceHotkey: (next: boolean) => Promise<void>;
}

export default function HotkeysStep({
  hotkeys,
  onToggleMainHotkey,
  onTogglePanelHotkey,
  onToggleVoiceHotkey,
}: HotkeysStepProps) {
  const frequentShortcuts = APP_SHORTCUTS.filter((s) => ONBOARDING_SHORTCUT_KEYS.includes(s.keys));

  return (
    <div className="onboarding-page" data-name="onboarding.page-actions">
      <h2 className="onboarding-page-title">上手动作</h2>
      <p className="onboarding-page-desc">记住三个全局热键，任何窗口都能随手呼出工百窗。</p>
      <div className="onboarding-shortcut-panel" data-name="onboarding.shortcut-panel">
        <div className="onboarding-shortcut-panel-head">
          <h3 className="onboarding-shortcut-panel-title">全局热键</h3>
          <span className="onboarding-shortcut-panel-hint">可在设置中自定义</span>
        </div>
        <div className="onboarding-shortcut-rows">
          {GLOBAL_HOTKEY_META.map((meta) => {
            const d = resolveHotkey(hotkeys, meta.action, meta.fallbackKeys);
            const toggleFn = meta.action === 'toggleMainWindow'
              ? onToggleMainHotkey
              : meta.action === 'toggleDetachedWindows'
                ? onTogglePanelHotkey
                : onToggleVoiceHotkey;
            return (
              <div
                key={meta.action}
                className={`onboarding-shortcut-row${d.enabled ? '' : ' is-disabled'}`}
                data-name={`onboarding.shortcut-row-${meta.action}`}
              >
                <span className="onboarding-shortcut-keys">{d.keys}</span>
                <span className="onboarding-shortcut-action">
                  {meta.actionText}
                </span>
                <Toggle
                  checked={d.enabled}
                  onChange={(v) => void toggleFn(v)}
                  aria-label={meta.actionText}
                />
              </div>
            );
          })}
        </div>
        <div className="onboarding-shortcut-panel-head">
          <h3 className="onboarding-shortcut-panel-title">高频窗口操作</h3>
        </div>
        <div className="onboarding-shortcut-rows">
          {frequentShortcuts.map((s) => (
            <div key={s.keys} className="onboarding-shortcut-row" data-name={`onboarding.shortcut-row-${s.keys}`}>
              <span className="onboarding-shortcut-keys">{s.keys}</span>
              <span className="onboarding-shortcut-action">{s.action}</span>
              <span className={`onboarding-scope-badge ${s.scope === '窗口内' ? 'is-window' : 'is-app'}`}>
                {s.scope}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="onboarding-shortcut-callout" data-name="onboarding.shortcut-callout">
        随时按 <kbd>`</kbd> 呼出<strong>完整快捷键速查</strong>（含各页面专属快捷键）。
      </p>
    </div>
  );
}
