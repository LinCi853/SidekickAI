import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { DevicePreset } from '../../../lib/electron-api';
import { savePreset, deletePreset } from '../../../lib/electron-api';
import Badge from '../../ui/Badge';
import Button from '../../ui/Button';

interface PresetSectionProps {
  presets: DevicePreset[];
  loading: boolean;
  presetExpanded: boolean;
  setPresetExpanded: Dispatch<SetStateAction<boolean>>;
  onReload: () => void;
}

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

export default function PresetSection({
  presets,
  loading,
  presetExpanded,
  setPresetExpanded,
  onReload,
}: PresetSectionProps) {
  // editingId: null=未编辑, 'new'=新增, 其他=正在编辑的预设 id
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DevicePreset>(emptyDraft());
  const [isSaving, setIsSaving] = useState(false);

  function handleAdd() {
    setDraft(emptyDraft());
    setEditingId('new');
  }

  function handleEdit(preset: DevicePreset) {
    setDraft({ ...preset });
    setEditingId(preset.id);
  }

  function handleCancel() {
    setEditingId(null);
  }

  async function handleSave() {
    if (!draft.name.trim() || !draft.userAgent.trim()) return;
    setIsSaving(true);
    try {
      // savePreset 为 upsert 语义：id 为空时由 store 生成 UUID，已有 id 时更新
      await savePreset(draft);
      setEditingId(null);
      onReload();
    } catch (e) {
      console.error('保存设备预设失败:', e);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('确定删除该设备预设？')) return;
    try {
      await deletePreset(id);
      onReload();
    } catch (e) {
      console.error('删除设备预设失败:', e);
    }
  }

  /** 更新草稿标量字段 */
  function updateField<K extends keyof DevicePreset>(key: K, value: DevicePreset[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** 更新视口字段 */
  function updateViewport(field: 'width' | 'height', value: number) {
    setDraft((d) => ({ ...d, viewport: { ...d.viewport, [field]: value } }));
  }

  return (
    <section data-name="settings.preset.section">
      <div
        className="settings-section-title-row collapsible"
        onClick={() => setPresetExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={presetExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPresetExpanded((v) => !v);
          }
        }}
        data-name="settings.preset.title-row"
      >
        <span className="settings-section-title" data-name="settings.preset.title">
          设备预设（{presets.length}）
        </span>
        <span className={`collapse-toggle-icon${presetExpanded ? ' expanded' : ''}`} data-name="settings.preset.collapse-icon">▼</span>
      </div>
      {presetExpanded && (
        <>
          {loading && (
            <div className="preset-loading" data-name="settings.preset.loading">
              加载中...
            </div>
          )}
          {!loading && presets.map((p, idx) => (
            <div
              key={p.id}
              className="preset-card"
              data-name={`settings.preset.preset-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={p.id}
            >
              {/* 编辑表单展开时替换卡片内容 */}
              {editingId === p.id ? (
                <PresetForm
                  draft={draft}
                  saving={isSaving}
                  onUpdateField={updateField}
                  onUpdateViewport={updateViewport}
                  onSave={() => void handleSave()}
                  onCancel={handleCancel}
                />
              ) : (
                <>
                  <div className="preset-card-head" data-name={`settings.preset.preset-item-${idx + 1}-head`}>
                    <span className="name" data-name={`settings.preset.preset-item-${idx + 1}-name`}>{p.name}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }} data-name={`settings.preset.preset-item-${idx + 1}-badges`}>
                      {p.builtin && <Badge variant="accent" data-name={`settings.preset.preset-item-${idx + 1}-builtin-badge`}>内置</Badge>}
                      <Badge variant={p.platform === 'mobile' ? 'warn' : 'accent'} data-name={`settings.preset.preset-item-${idx + 1}-platform-badge`}>
                        {p.platform === 'mobile' ? '移动端' : '桌面端'}
                      </Badge>
                    </div>
                  </div>
                  <div className="preset-card-meta" title={p.userAgent} data-name={`settings.preset.preset-item-${idx + 1}-meta`}>
                    {p.viewport.width}×{p.viewport.height} · DPR {p.devicePixelRatio} · {p.language}
                  </div>
                  <div className="provider-card-actions spaced" data-name={`settings.preset.preset-item-${idx + 1}-actions`}>
                    <Button
                      variant="text"
                      className="provider-action-btn"
                      onClick={() => handleEdit(p)}
                      data-name={`settings.preset.preset-item-${idx + 1}-edit-button`}
                    >
                      编辑
                    </Button>
                    {!p.builtin && (
                      <Button
                        variant="text"
                        danger
                        className="provider-action-btn"
                        onClick={() => void handleDelete(p.id)}
                        data-name={`settings.preset.preset-item-${idx + 1}-delete-button`}
                      >
                        删除
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
          {/* 新增表单 */}
          {editingId === 'new' && (
            <div className="preset-card" data-name="settings.preset.new-card">
              <PresetForm
                draft={draft}
                saving={isSaving}
                onUpdateField={updateField}
                onUpdateViewport={updateViewport}
                onSave={() => void handleSave()}
                onCancel={handleCancel}
              />
            </div>
          )}
          {/* 新增按钮（表单未打开时显示） */}
          {editingId !== 'new' && (
            <Button
              variant="ghost"
              className="provider-add-btn spaced"
              onClick={handleAdd}
              data-name="settings.preset.add-button"
            >
              + 新增预设
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** 预设编辑/新增表单（内联展开式） */
interface PresetFormProps {
  draft: DevicePreset;
  saving: boolean;
  onUpdateField: <K extends keyof DevicePreset>(key: K, value: DevicePreset[K]) => void;
  onUpdateViewport: (field: 'width' | 'height', value: number) => void;
  onSave: () => void;
  onCancel: () => void;
}

function PresetForm({
  draft,
  saving,
  onUpdateField,
  onUpdateViewport,
  onSave,
  onCancel,
}: PresetFormProps) {
  return (
    <div className="provider-form" data-name="settings.preset.form">
      <div className="provider-form-row" data-name="settings.preset.form-name-row">
        <label className="provider-form-label" data-name="settings.preset.form-name-label">名称</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.name}
          placeholder="Windows / Chrome 125"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('name', e.target.value)}
          data-name="settings.preset.form-name-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-platform-row">
        <label className="provider-form-label" data-name="settings.preset.form-platform-label">平台</label>
        <select
          className="provider-form-input"
          value={draft.platform}
          onChange={(e) => onUpdateField('platform', e.target.value as DevicePreset['platform'])}
          data-name="settings.preset.form-platform-select"
        >
          <option value="desktop">desktop</option>
          <option value="mobile">mobile</option>
        </select>
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-user-agent-row">
        <label className="provider-form-label" data-name="settings.preset.form-user-agent-label">User-Agent</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.userAgent}
          placeholder="Mozilla/5.0 ..."
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('userAgent', e.target.value)}
          data-name="settings.preset.form-user-agent-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-viewport-width-row">
        <label className="provider-form-label" data-name="settings.preset.form-viewport-width-label">视口宽度</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.viewport.width}
          min={1}
          onChange={(e) => onUpdateViewport('width', Number(e.target.value))}
          data-name="settings.preset.form-viewport-width-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-viewport-height-row">
        <label className="provider-form-label" data-name="settings.preset.form-viewport-height-label">视口高度</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.viewport.height}
          min={1}
          onChange={(e) => onUpdateViewport('height', Number(e.target.value))}
          data-name="settings.preset.form-viewport-height-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-dpr-row">
        <label className="provider-form-label" data-name="settings.preset.form-dpr-label">设备像素比 (DPR)</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.devicePixelRatio}
          min={0}
          step={0.5}
          onChange={(e) => onUpdateField('devicePixelRatio', Number(e.target.value))}
          data-name="settings.preset.form-dpr-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-navigator-platform-row">
        <label className="provider-form-label" data-name="settings.preset.form-navigator-platform-label">navigator.platform</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.navigatorPlatform}
          placeholder="Win32"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('navigatorPlatform', e.target.value)}
          data-name="settings.preset.form-navigator-platform-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-vendor-row">
        <label className="provider-form-label" data-name="settings.preset.form-vendor-label">navigator.vendor</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.vendor}
          placeholder="Google Inc."
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('vendor', e.target.value)}
          data-name="settings.preset.form-vendor-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-touch-points-row">
        <label className="provider-form-label" data-name="settings.preset.form-touch-points-label">最大触点数</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.maxTouchPoints}
          min={0}
          onChange={(e) => onUpdateField('maxTouchPoints', Number(e.target.value))}
          data-name="settings.preset.form-touch-points-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-cpu-cores-row">
        <label className="provider-form-label" data-name="settings.preset.form-cpu-cores-label">CPU 核心数</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.hardwareConcurrency}
          min={1}
          onChange={(e) => onUpdateField('hardwareConcurrency', Number(e.target.value))}
          data-name="settings.preset.form-cpu-cores-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-device-memory-row">
        <label className="provider-form-label" data-name="settings.preset.form-device-memory-label">设备内存 (GB)</label>
        <input
          type="number"
          className="provider-form-input"
          value={draft.deviceMemory}
          min={1}
          onChange={(e) => onUpdateField('deviceMemory', Number(e.target.value))}
          data-name="settings.preset.form-device-memory-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-ch-platform-row">
        <label className="provider-form-label" data-name="settings.preset.form-ch-platform-label">Client Hints 平台</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.chPlatform}
          placeholder="Windows"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('chPlatform', e.target.value)}
          data-name="settings.preset.form-ch-platform-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-ch-platform-version-row">
        <label className="provider-form-label" data-name="settings.preset.form-ch-platform-version-label">Client Hints 平台版本</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.chPlatformVersion}
          placeholder="10.0.0"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('chPlatformVersion', e.target.value)}
          data-name="settings.preset.form-ch-platform-version-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-ch-mobile-row">
        <label className="provider-form-label" data-name="settings.preset.form-ch-mobile-label">Client Hints 移动端</label>
        <select
          className="provider-form-input"
          value={String(draft.chMobile)}
          onChange={(e) => onUpdateField('chMobile', e.target.value === 'true')}
          data-name="settings.preset.form-ch-mobile-select"
        >
          <option value="false">否</option>
          <option value="true">是</option>
        </select>
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-language-row">
        <label className="provider-form-label" data-name="settings.preset.form-language-label">默认语言</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.language}
          placeholder="zh-CN"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('language', e.target.value)}
          data-name="settings.preset.form-language-input"
        />
      </div>
      <div className="provider-form-row" data-name="settings.preset.form-timezone-row">
        <label className="provider-form-label" data-name="settings.preset.form-timezone-label">默认时区</label>
        <input
          type="text"
          className="provider-form-input"
          value={draft.timezone}
          placeholder="Asia/Shanghai"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onUpdateField('timezone', e.target.value)}
          data-name="settings.preset.form-timezone-input"
        />
      </div>
      <div className="provider-form-actions" data-name="settings.preset.form-actions">
        <Button
          variant="primary-compact"
          className="provider-form-btn"
          disabled={saving || !draft.name.trim() || !draft.userAgent.trim()}
          onClick={onSave}
          data-name="settings.preset.form-save-button"
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button
          variant="text"
          className="provider-form-btn"
          disabled={saving}
          onClick={onCancel}
          data-name="settings.preset.form-cancel-button"
        >
          取消
        </Button>
      </div>
    </div>
  );
}
