/* =====================================================================
   PresetEditorModal —— 设备预设编辑器（设置页内遮罩）
   由原 PresetSection 内联表单迁移而来，与 AiAppEditorModal 结构一致。
   ===================================================================== */

import { useState, useEffect, useCallback } from 'react';
import type { DevicePreset } from '../lib/electron-api';
import { savePreset } from '../lib/electron-api';
import { useToast } from '../hooks/useToast';
import Button from './ui/Button';
import Modal from './ui/Modal';
import { Combobox } from './ui';
import '../pages/PromptLibraryView.css';
import './AiAppEditorModal.css';

/** 创建空白预设草稿（新增时使用） */
function emptyDraft(): DevicePreset {
  return {
    id: '',
    name: '',
    userAgent: '',
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigatorPlatform: 'Win32',
    vendor: 'Google Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'Windows',
    chPlatformVersion: '10.0.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  };
}

export interface PresetEditorModalProps {
  open: boolean;
  onClose: () => void;
  /** 编辑模式：指定预设；新建模式：不传或 mode='create' */
  preset?: DevicePreset | null;
  mode?: 'edit' | 'create';
  onSaved?: () => void;
}

export default function PresetEditorModal({
  open,
  onClose,
  preset,
  mode = 'edit',
  onSaved,
}: PresetEditorModalProps) {
  const isCreateMode = mode === 'create';
  const [draft, setDraft] = useState<DevicePreset>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const { toast, showToast } = useToast();

  // 打开时初始化草稿
  useEffect(() => {
    if (!open) return;
    if (isCreateMode) {
      setDraft(emptyDraft());
    } else if (preset) {
      setDraft({ ...preset });
    } else {
      setDraft(emptyDraft());
    }
  }, [open, isCreateMode, preset]);

  /** 更新草稿标量字段 */
  const updateField = useCallback(<K extends keyof DevicePreset>(key: K, value: DevicePreset[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  /** 更新视口字段 */
  const updateViewport = useCallback((field: 'width' | 'height', value: number) => {
    setDraft((d) => ({ ...d, viewport: { ...d.viewport, [field]: value } }));
  }, []);

  const handleSave = async () => {
    if (!draft.name.trim()) {
      showToast('请填写名称');
      return;
    }
    if (!draft.userAgent.trim()) {
      showToast('请填写 User-Agent');
      return;
    }
    setSaving(true);
    try {
      await savePreset(draft);
      showToast(isCreateMode ? '已创建' : '已保存');
      onSaved?.();
      onClose();
    } catch (e) {
      console.error('[PresetEditorModal] 保存失败:', e);
      showToast('保存失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  };

  const title = isCreateMode ? '新建设备预设' : `编辑设备预设${preset?.name ? ' · ' + preset.name : ''}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      portal
      className="ai-app-editor-modal"
    >
      <div className="ai-app-editor-body" data-name="preset-editor.body">
        <FieldGroup label="名称">
          <input
            type="text"
            className="ai-editor-input"
            value={draft.name}
            placeholder="Chrome 125 / Safari 17 等"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateField('name', e.target.value)}
            data-name="preset-editor.name-input"
          />
        </FieldGroup>

        <div className="provider-form-inline-row" data-name="preset-editor.platform-viewport-row">
          <FieldGroup label="平台">
            <Combobox
              inputValue={draft.platform}
              onInputChange={() => {}}
              inputPlaceholder="选择平台"
              inputClassName="ai-editor-input"
              inputReadOnly
              options={[
                { value: 'desktop', label: 'desktop', selected: draft.platform === 'desktop' },
                { value: 'mobile', label: 'mobile', selected: draft.platform === 'mobile' },
              ]}
              onSelect={(v) => updateField('platform', v as DevicePreset['platform'])}
              searchable={false}
              dataName="preset-editor.platform-select"
            />
          </FieldGroup>
          <FieldGroup label="视口">
            <div className="preset-viewport-pair">
              <input
                type="number"
                className="ai-editor-input"
                value={draft.viewport.width}
                min={1}
                aria-label="视口宽度"
                onChange={(e) => updateViewport('width', Number(e.target.value))}
                data-name="preset-editor.viewport-width-input"
              />
              <span className="preset-viewport-sep">×</span>
              <input
                type="number"
                className="ai-editor-input"
                value={draft.viewport.height}
                min={1}
                aria-label="视口高度"
                onChange={(e) => updateViewport('height', Number(e.target.value))}
                data-name="preset-editor.viewport-height-input"
              />
            </div>
          </FieldGroup>
        </div>

        <FieldGroup label="User-Agent">
          <input
            type="text"
            className="ai-editor-input"
            value={draft.userAgent}
            placeholder="Mozilla/5.0 ..."
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateField('userAgent', e.target.value)}
            data-name="preset-editor.user-agent-input"
          />
        </FieldGroup>

        <div className="provider-form-inline-row" data-name="preset-editor.hardware-row">
          <FieldGroup label="DPR">
            <input
              type="number"
              className="ai-editor-input"
              value={draft.devicePixelRatio}
              min={0}
              step={0.5}
              onChange={(e) => updateField('devicePixelRatio', Number(e.target.value))}
              data-name="preset-editor.dpr-input"
            />
          </FieldGroup>
          <FieldGroup label="触点">
            <input
              type="number"
              className="ai-editor-input"
              value={draft.maxTouchPoints}
              min={0}
              onChange={(e) => updateField('maxTouchPoints', Number(e.target.value))}
              data-name="preset-editor.touch-points-input"
            />
          </FieldGroup>
          <FieldGroup label="CPU">
            <input
              type="number"
              className="ai-editor-input"
              value={draft.hardwareConcurrency}
              min={1}
              onChange={(e) => updateField('hardwareConcurrency', Number(e.target.value))}
              data-name="preset-editor.cpu-cores-input"
            />
          </FieldGroup>
          <FieldGroup label="内存(GB)">
            <input
              type="number"
              className="ai-editor-input"
              value={draft.deviceMemory}
              min={1}
              onChange={(e) => updateField('deviceMemory', Number(e.target.value))}
              data-name="preset-editor.device-memory-input"
            />
          </FieldGroup>
        </div>

        <FieldGroup label="navigator.platform">
          <input
            type="text"
            className="ai-editor-input"
            value={draft.navigatorPlatform}
            placeholder="Win32"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateField('navigatorPlatform', e.target.value)}
            data-name="preset-editor.navigator-platform-input"
          />
        </FieldGroup>

        <FieldGroup label="navigator.vendor">
          <input
            type="text"
            className="ai-editor-input"
            value={draft.vendor}
            placeholder="Google Inc."
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => updateField('vendor', e.target.value)}
            data-name="preset-editor.vendor-input"
          />
        </FieldGroup>

        <div className="provider-form-inline-row" data-name="preset-editor.ch-row">
          <FieldGroup label="CH 平台">
            <input
              type="text"
              className="ai-editor-input"
              value={draft.chPlatform}
              placeholder="Windows"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateField('chPlatform', e.target.value)}
              data-name="preset-editor.ch-platform-input"
            />
          </FieldGroup>
          <FieldGroup label="版本">
            <input
              type="text"
              className="ai-editor-input"
              value={draft.chPlatformVersion}
              placeholder="10.0.0"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateField('chPlatformVersion', e.target.value)}
              data-name="preset-editor.ch-platform-version-input"
            />
          </FieldGroup>
          <FieldGroup label="移动端">
            <Combobox
              inputValue={draft.chMobile ? '是' : '否'}
              onInputChange={() => {}}
              inputPlaceholder="选择"
              inputClassName="ai-editor-input"
              inputReadOnly
              options={[
                { value: 'false', label: '否', selected: !draft.chMobile },
                { value: 'true', label: '是', selected: draft.chMobile },
              ]}
              onSelect={(v) => updateField('chMobile', v === 'true')}
              searchable={false}
              dataName="preset-editor.ch-mobile-select"
            />
          </FieldGroup>
        </div>

        <div className="provider-form-inline-row" data-name="preset-editor.locale-row">
          <FieldGroup label="语言">
            <input
              type="text"
              className="ai-editor-input"
              value={draft.language}
              placeholder="zh-CN"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateField('language', e.target.value)}
              data-name="preset-editor.language-input"
            />
          </FieldGroup>
          <FieldGroup label="时区">
            <input
              type="text"
              className="ai-editor-input"
              value={draft.timezone}
              placeholder="Asia/Shanghai"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => updateField('timezone', e.target.value)}
              data-name="preset-editor.timezone-input"
            />
          </FieldGroup>
        </div>

        {/* 操作按钮 */}
        <div className="ai-app-editor-footer" data-name="preset-editor.footer-actions">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            data-name="preset-editor.cancel-button"
          >
            取消
          </Button>
          <Button
            variant="primary-compact"
            onClick={() => void handleSave()}
            disabled={saving || !draft.name.trim() || !draft.userAgent.trim()}
            data-name="preset-editor.save-button"
          >
            {saving ? '保存中…' : (isCreateMode ? '创建' : '保存')}
          </Button>
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div className="prompt-toast app-toast is-open" role="status" aria-live="polite" data-name="preset-editor.toast">
          {toast}
        </div>
      )}
    </Modal>
  );
}

/* =====================================================================
   子组件：字段分组
   ===================================================================== */
function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ai-app-editor-field-group" data-name="preset-editor.field-group">
      <label className="ai-app-editor-field-label" data-name="preset-editor.field-group-label">
        {label}
      </label>
      {children}
    </div>
  );
}
