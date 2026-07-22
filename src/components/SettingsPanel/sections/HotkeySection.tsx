import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { HotkeyConfig, HotkeyAction } from '../../../lib/electron-api';
import { startHotkeyRecording, stopHotkeyRecording, onHotkeyRecordingResult } from '../../../lib/electron-api';
import Button from '../../ui/Button';
import HotkeyRecorder from '../../ui/HotkeyRecorder';

interface HotkeySectionProps {
  hotkeys: HotkeyConfig[];
  drafts: Record<string, string>;
  savingAction: HotkeyAction | null;
  feedback: Record<string, { type: 'success' | 'error'; msg: string } | null>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  handleSaveHotkey: (action: HotkeyAction) => Promise<void>;
  onToggleEnabled?: (action: HotkeyAction, enabled: boolean) => Promise<void>;
  onOpenShortcuts?: () => void;
  altSpaceResetThreshold?: number;
  onAltSpaceThresholdChange?: (value: number) => Promise<void>;
}

export default function HotkeySection({
  hotkeys,
  drafts,
  savingAction,
  feedback,
  setDrafts,
  handleSaveHotkey,
  onToggleEnabled,
  onOpenShortcuts,
  altSpaceResetThreshold,
  onAltSpaceThresholdChange,
}: HotkeySectionProps) {
  const [thresholdDraft, setThresholdDraft] = useState<string>(
    altSpaceResetThreshold != null ? String(altSpaceResetThreshold) : '',
  );

  useEffect(() => {
    if (altSpaceResetThreshold != null) {
      setThresholdDraft(String(altSpaceResetThreshold));
    }
  }, [altSpaceResetThreshold]);

  const handleThresholdBlur = () => {
    if (!onAltSpaceThresholdChange) return;
    const parsed = parseInt(thresholdDraft, 10);
    if (!Number.isFinite(parsed)) {
      if (altSpaceResetThreshold != null) setThresholdDraft(String(altSpaceResetThreshold));
      return;
    }
    const clamped = Math.max(3, Math.min(20, parsed));
    setThresholdDraft(String(clamped));
    if (clamped !== altSpaceResetThreshold) {
      void onAltSpaceThresholdChange(clamped);
    }
  };

  return (
    <section data-name="settings.hotkey.section">
      <div className="settings-section-title-row" data-name="settings.hotkey.title-row">
        <div className="settings-section-title" data-name="settings.hotkey.title">全局热键</div>
        {onOpenShortcuts && (
          <Button
            variant="link"
            className="hotkey-shortcuts-link"
            onClick={onOpenShortcuts}
            title="查看全部快捷键"
            data-name="settings.hotkey.shortcuts-link-button"
          >
            查看全部
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="settings.hotkey.shortcuts-link-icon">
              <path d="M7 17L17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </Button>
        )}
      </div>
      {/* 需求 2.5：提示词库内自定义快捷键的说明 */}
      <div className="hotkey-section-hint" data-name="settings.hotkey.prompt-hint">
        提示词库内自定义快捷键在此不显示，请在提示词库编辑中管理
      </div>
      <div className="hotkey-list" data-name="settings.hotkey.hotkey-list">
        {hotkeys.map((h, idx) => {
          const draft = drafts[h.action] ?? '';
          const fb = feedback[h.action];
          const dirty = draft.trim() !== h.accelerator;
          const isTestFeature = h.action === 'backgroundVoice';
          return (
            <div
              key={h.action}
              className={`hotkey-item${h.enabled ? '' : ' is-disabled'}`}
              data-name={`settings.hotkey.hotkey-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={h.action}
            >
              <div className="hotkey-item-header" data-name={`settings.hotkey.hotkey-item-${idx + 1}-header`}>
                <span className="hotkey-item-name" data-name={`settings.hotkey.hotkey-item-${idx + 1}-name`}>
                  {h.label}
                  {isTestFeature && (
                    <span
                      className="hotkey-item-badge"
                      style={{
                        marginLeft: '6px',
                        fontSize: '10px',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: 'var(--warning, #f59e0b)',
                        color: '#fff',
                        verticalAlign: 'middle',
                      }}
                      data-name={`settings.hotkey.hotkey-item-${idx + 1}-badge`}
                    >
                      测试
                    </span>
                  )}
                </span>
                <label
                  className="toggle"
                  title={h.enabled ? '已启用' : '已禁用'}
                  data-name={`settings.hotkey.hotkey-item-${idx + 1}-toggle`}
                >
                  <input
                    type="checkbox"
                    checked={h.enabled}
                    onChange={(e) => {
                      void onToggleEnabled?.(h.action, e.target.checked);
                    }}
                    data-name={`settings.hotkey.hotkey-item-${idx + 1}-toggle-input`}
                  />
                  <span className="toggle-track" data-name={`settings.hotkey.hotkey-item-${idx + 1}-toggle-track`} />
                </label>
              </div>
              <div className="hotkey-input-row" data-name={`settings.hotkey.hotkey-item-${idx + 1}-input-row`}>
                <HotkeyRecorder
                  value={draft}
                  placeholder={h.accelerator || 'Alt+Space'}
                  className="hotkey-input"
                  onRecord={(acc) => setDrafts((p) => ({ ...p, [h.action]: acc }))}
                  otherHotkeys={hotkeys
                    .filter((other) => other.action !== h.action)
                    .map((other) => ({ label: other.label, accelerator: other.accelerator }))}
                  startRecording={startHotkeyRecording}
                  stopRecording={stopHotkeyRecording}
                  onRecordingResult={onHotkeyRecordingResult}
                />
                {dirty && (
                  <Button
                    variant="primary-compact"
                    className="hotkey-save"
                    disabled={savingAction === h.action}
                    onClick={() => void handleSaveHotkey(h.action)}
                    data-name={`settings.hotkey.hotkey-item-${idx + 1}-save-button`}
                  >
                    {savingAction === h.action ? '保存中…' : '保存'}
                  </Button>
                )}
              </div>
              {fb && (
                <div className={`hotkey-feedback ${fb.type}`} data-name={`settings.hotkey.hotkey-item-${idx + 1}-feedback`}>{fb.msg}</div>
              )}
            </div>
          );
        })}
      </div>
      {altSpaceResetThreshold !== undefined && onAltSpaceThresholdChange && (
        <div className="proxy-custom-block" data-name="settings.hotkey.alt-space-block">
          <div className="voice-config-name voice-section-subtitle" data-name="settings.hotkey.alt-space-subtitle">
            Alt+Space 窗口位置恢复
          </div>
          <div className="voice-config-row" data-name="settings.hotkey.alt-space-threshold-row">
            <label className="voice-config-label" data-name="settings.hotkey.alt-space-threshold-label">
              <span className="voice-config-name" data-name="settings.hotkey.alt-space-threshold-name">触发次数</span>
              <span className="voice-config-hint" data-name="settings.hotkey.alt-space-threshold-hint">默认 6，范围 3-20</span>
            </label>
            <input
              type="number"
              className="voice-input"
              min={3}
              max={20}
              value={thresholdDraft}
              onChange={(e) => setThresholdDraft(e.target.value)}
              onBlur={handleThresholdBlur}
              style={{ width: 80 }}
              data-name="settings.hotkey.alt-space-threshold-input"
            />
          </div>
        </div>
      )}
    </section>
  );
}
