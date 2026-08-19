/* =====================================================================
   SettingsPanel/sections/provider/ProviderEditForm —— 供应商编辑/新建表单
   从 ProviderSection.tsx 拆出（Modal 替代原 .provider-edit-overlay；
   portal=true：渲染到 document.body，脱离侧滑面板 transform 的影响，全屏覆盖进阶面板）。
   所有状态与副作用逻辑仍由 ProviderSection 容器持有，此处仅负责渲染表单字段。
   ===================================================================== */

import { Button, IconButton, Modal, SegmentedControl, FormRow, Combobox } from '../../../ui';
import type { ComboboxOption } from '../../../ui';
import type { CustomAIProviderInput } from '../../../../lib/electron-api';
import { PRESETS } from './presets.js';
import type { ProviderPreset } from './presets.js';

/** 测试连通性结果 */
export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

interface ProviderEditFormProps {
  /** 当前编辑/新建的供应商载荷（null 时表单关闭） */
  editing: CustomAIProviderInput | null;
  /** 是否正在测试连通性 */
  testing: boolean;
  /** 测试结果（ok / fail） */
  testResult: TestResult | null;
  /** 是否正在保存 */
  saving: boolean;
  /** API Key 是否明文显示（v0.5.2 regress-4：眼睛图标） */
  showApiKey: boolean;
  onToggleApiKey: () => void;
  /** 需求 9：模型搜索候选 */
  modelCandidates: string[];
  /** 是否正在搜索可用模型 */
  searchingModels: boolean;
  /** 主模型下拉开关 */
  showModelDropdown: boolean;
  onShowModelDropdownChange: (open: boolean) => void;
  /** TTS 模型下拉开关 */
  showTtsDropdown: boolean;
  onShowTtsDropdownChange: (open: boolean) => void;
  /** STT 模型下拉开关 */
  showSttDropdown: boolean;
  onShowSttDropdownChange: (open: boolean) => void;
  /** TTS 自动搜索中 */
  autoSearchingTts: boolean;
  /** STT 自动搜索中 */
  autoSearchingStt: boolean;
  /** 通用字段更新 */
  onFieldChange: <K extends keyof CustomAIProviderInput>(key: K, value: CustomAIProviderInput[K]) => void;
  /** API 端点变化（自动推断协议） */
  onEndpointChange: (value: string) => void;
  /** 应用预设（填入 endpoint + model + protocol） */
  onApplyPreset: (preset: ProviderPreset) => void;
  /** 搜索供应商可用模型列表（不要求 API Key） */
  onSearchModels: (overrideInput?: CustomAIProviderInput) => void;
  /** TTS 开关切换 */
  onTtsToggle: (v: string) => void;
  /** STT 开关切换 */
  onSttToggle: (v: string) => void;
  /** 勾选/取消勾选模型 */
  onToggleModel: (modelName: string, checked: boolean) => void;
  /** 移除已选模型 Chip */
  onRemoveModelChip: (modelName: string) => void;
  /** 语音候选是否匹配 TTS 关键词 */
  isTtsModel: (m: string) => boolean;
  /** 语音候选是否匹配 STT 关键词 */
  isSttModel: (m: string) => boolean;
  /** 测试连通性 */
  onTest: () => void;
  /** 保存 */
  onSave: () => void;
  /** 取消（关闭表单） */
  onCancel: () => void;
}

export default function ProviderEditForm({
  editing,
  testing,
  testResult,
  saving,
  showApiKey,
  onToggleApiKey,
  modelCandidates,
  searchingModels,
  showModelDropdown,
  onShowModelDropdownChange,
  showTtsDropdown,
  onShowTtsDropdownChange,
  showSttDropdown,
  onShowSttDropdownChange,
  autoSearchingTts,
  autoSearchingStt,
  onFieldChange,
  onEndpointChange,
  onApplyPreset,
  onSearchModels,
  onTtsToggle,
  onSttToggle,
  onToggleModel,
  onRemoveModelChip,
  isTtsModel,
  isSttModel,
  onTest,
  onSave,
  onCancel,
}: ProviderEditFormProps) {
  return (
    <Modal
      open={editing !== null}
      onClose={onCancel}
      title="编辑供应商"
      className="provider-edit-modal"
      portal
      data-name="advanced-panel.provider-form"
    >
      {editing && (
        <>
          <FormRow label="名称" data-name="advanced-panel.provider-form-name-row">
            <input
              type="text"
              className="provider-form-input"
              value={editing.name}
              placeholder="My OpenAI"
              spellCheck={false}
              autoComplete="off"
              data-name="advanced-panel.provider-form-name-input"
              onChange={(e) => onFieldChange('name', e.target.value)}
            />
          </FormRow>
          {/* API 端点 + 预设下拉合并为 Combobox：输入框可自定义端点，下拉箭头展开供应商预设 */}
          <FormRow label="API 端点" compact data-name="advanced-panel.provider-form-endpoint-row">
            <Combobox
              inputValue={editing.apiEndpoint}
              onInputChange={(v) => onEndpointChange(v)}
              inputPlaceholder="https://api.openai.com/v1/chat/completions"
              inputClassName="provider-form-input"
              options={PRESETS.map<ComboboxOption>((p) => ({
                value: p.id,
                label: p.label,
                selected: p.endpoint === editing.apiEndpoint,
              }))}
              onSelect={(v) => {
                const preset = PRESETS.find(p => p.id === v);
                if (preset) onApplyPreset(preset);
              }}
              searchable
              searchPlaceholder="搜索供应商预设…"
              emptyText="无匹配预设，可直接输入端点"
              dataName="advanced-panel.provider-form-endpoint"
            />
          </FormRow>
          <FormRow label="API 密钥" data-name="advanced-panel.provider-form-api-key-row">
            <div className="provider-api-key-wrapper" data-name="advanced-panel.provider-form-api-key-wrapper">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="provider-form-input"
                value={editing.apiKey}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
                data-name="advanced-panel.provider-form-api-key-input"
                onChange={(e) => onFieldChange('apiKey', e.target.value)}
              />
              <IconButton
                type="button"
                className="provider-api-key-toggle"
                aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                title={showApiKey ? '隐藏密钥' : '显示密钥'}
                data-name="advanced-panel.provider-form-api-key-toggle"
                onClick={onToggleApiKey}
              >
                {showApiKey ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </IconButton>
            </div>
          </FormRow>
          <FormRow label="模型" compact data-name="advanced-panel.provider-form-model-row">
            <div className="provider-model-section" data-name="advanced-panel.provider-form-model-section">
              {/* 第一行：模型输入 + 搜索按钮 + 统一下拉（右侧无其他组件） */}
              <div className="provider-model-combobox" data-name="advanced-panel.provider-form-model-combobox">
                <Combobox
                  inputValue={editing.model}
                  onInputChange={(v) => onFieldChange('model', v)}
                  inputPlaceholder="gpt-4o-mini"
                  inputClassName="provider-form-input"
                  options={modelCandidates.map<ComboboxOption>((m) => {
                    const isSelected = editing.model === m || (editing.alternativeModels?.includes(m) ?? false);
                    return {
                      value: m,
                      label: m,
                      selected: isSelected,
                    };
                  })}
                  onSelect={(v) => onToggleModel(v, true)}
                  onDeselect={(v) => onToggleModel(v, false)}
                  multiple
                  searchable
                  searchPlaceholder="搜索模型名…"
                  open={showModelDropdown}
                  onOpenChange={onShowModelDropdownChange}
                  loading={searchingModels}
                  loadingText="正在搜索可用模型…"
                  emptyText={modelCandidates.length === 0 ? '点击右侧搜索按钮查询可用模型' : '无匹配项'}
                  dataName="advanced-panel.provider-form-model"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="provider-model-search-btn"
                  disabled={searchingModels}
                  onClick={() => void onSearchModels()}
                  data-name="advanced-panel.provider-form-model-search-button"
                >
                  {searchingModels ? '搜索中…' : '搜索'}
                </Button>
              </div>
              {/* 第二行：已选模型 chips（换行展示，无主次区分） */}
              {(editing.model || (editing.alternativeModels?.length ?? 0) > 0) && (
                <div className="provider-model-chips" data-name="advanced-panel.provider-form-model-chips">
                  {[
                    editing.model,
                    ...(editing.alternativeModels ?? []),
                  ].filter(Boolean).map((m) => (
                    <span key={m} className="provider-model-chip" data-name={`advanced-panel.provider-form-model-chip-${m}`}>
                      {m}
                      <button
                        type="button"
                        className="provider-model-chip-remove"
                        aria-label={`移除 ${m}`}
                        onClick={() => onRemoveModelChip(m)}
                        data-name={`advanced-panel.provider-form-model-chip-${m}-remove`}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </FormRow>
          <div className="provider-form-inline-row" data-name="advanced-panel.provider-form-number-row">
            <FormRow label="温度" compact data-name="advanced-panel.provider-form-temperature-row">
              <input
                type="number"
                className="provider-form-input"
                value={editing.temperature ?? ''}
                min={0}
                max={2}
                step={0.1}
                placeholder="0.7"
                data-name="advanced-panel.provider-form-temperature-input"
                onChange={(e) => {
                  const v = e.target.value;
                  onFieldChange('temperature', v === '' ? undefined : Number(v));
                }}
              />
            </FormRow>
            <FormRow label="最大 token" compact data-name="advanced-panel.provider-form-max-tokens-row">
              <input
                type="number"
                className="provider-form-input"
                value={editing.maxTokens ?? ''}
                min={1}
                placeholder="4096"
                data-name="advanced-panel.provider-form-max-tokens-input"
                onChange={(e) => {
                  const v = e.target.value;
                  onFieldChange('maxTokens', v === '' ? undefined : Number(v));
                }}
              />
            </FormRow>
          </div>
          <FormRow label="语音" compact data-name="advanced-panel.provider-form-voice-row">
            <div className="provider-voice-compact">
              <div className="provider-voice-item">
                <span className="provider-voice-item-label">TTS</span>
                <SegmentedControl
                  value={editing.ttsEnabled ? 'on' : 'off'}
                  onChange={(v) => void onTtsToggle(v)}
                  name="tts-toggle"
                  options={[
                    { value: 'off', label: '关' },
                    { value: 'on', label: '开' },
                  ]}
                />
                {editing.ttsEnabled && (
                  <Combobox
                    inputValue={editing.ttsModel ?? ''}
                    onInputChange={(v) => onFieldChange('ttsModel', v)}
                    inputPlaceholder="tts-1"
                    inputClassName="provider-form-input provider-voice-model-input"
                    options={modelCandidates.map<ComboboxOption>((m) => ({
                      value: m,
                      label: m,
                      selected: editing.ttsModel === m,
                      tag: isTtsModel(m) ? 'TTS' : undefined,
                    }))}
                    onSelect={(v) => onFieldChange('ttsModel', v)}
                    searchable
                    searchPlaceholder="搜索模型…"
                    open={showTtsDropdown}
                    onOpenChange={onShowTtsDropdownChange}
                    loading={autoSearchingTts}
                    loadingText="正在自动搜索模型…"
                    emptyText={modelCandidates.length === 0 ? '正在搜索模型…' : '无可用模型'}
                    dataName="advanced-panel.provider-form-tts-model"
                  />
                )}
              </div>
              <div className="provider-voice-item">
                <span className="provider-voice-item-label">STT</span>
                <SegmentedControl
                  value={editing.sttEnabled ? 'on' : 'off'}
                  onChange={(v) => void onSttToggle(v)}
                  name="stt-toggle"
                  options={[
                    { value: 'off', label: '关' },
                    { value: 'on', label: '开' },
                  ]}
                />
                {editing.sttEnabled && (
                  <Combobox
                    inputValue={editing.sttModel ?? ''}
                    onInputChange={(v) => onFieldChange('sttModel', v)}
                    inputPlaceholder="whisper-1"
                    inputClassName="provider-form-input provider-voice-model-input"
                    options={modelCandidates.map<ComboboxOption>((m) => ({
                      value: m,
                      label: m,
                      selected: editing.sttModel === m,
                      tag: isSttModel(m) ? 'STT' : undefined,
                    }))}
                    onSelect={(v) => onFieldChange('sttModel', v)}
                    searchable
                    searchPlaceholder="搜索模型…"
                    open={showSttDropdown}
                    onOpenChange={onShowSttDropdownChange}
                    loading={autoSearchingStt}
                    loadingText="正在自动搜索模型…"
                    emptyText={modelCandidates.length === 0 ? '正在搜索模型…' : '无可用模型'}
                    dataName="advanced-panel.provider-form-stt-model"
                  />
                )}
              </div>
            </div>
          </FormRow>
          {testResult && (
            <div className={`provider-test-result test-result ${testResult.ok ? 'ok' : 'fail'}`} data-name="advanced-panel.provider-form-test-result">
              {testResult.ok ? '连通正常' : '连通失败'}：{testResult.message}
              {typeof testResult.latencyMs === 'number' ? `（${testResult.latencyMs}ms）` : ''}
            </div>
          )}
          <div className="provider-form-actions" data-name="advanced-panel.provider-form-actions">
            <Button type="button" variant="outline" className="provider-form-btn" disabled={testing || saving} onClick={() => void onTest()} data-name="advanced-panel.provider-form-test-button">
              {testing ? '测试中…' : '测试连通性'}
            </Button>
            <Button type="button" variant="primary-flat" className="provider-form-btn" disabled={testing || saving} onClick={() => void onSave()} data-name="advanced-panel.provider-form-save-button">
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button type="button" variant="outline" className="provider-form-btn" disabled={testing || saving} onClick={onCancel} data-name="advanced-panel.provider-form-cancel-button">取消</Button>
          </div>
        </>
      )}
    </Modal>
  );
}
