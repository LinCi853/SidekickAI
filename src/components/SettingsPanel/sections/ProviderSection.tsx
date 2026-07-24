/* =====================================================================
   SettingsPanel/sections/ProviderSection —— 自定义 AI 供应商管理分区
   从 pages/AiProviderAppView.tsx 的 ProvidersModal 迁移而来。
   - 外层 SectionTitle collapsible（替代 .providers-modal-header）
   - 卡片列表保留 .provider-card 类（列表行风格，与 SettingsPanel 其他 section 一致）
   - 编辑表单 / 加密导出 / 加密导入 改用 ui/Modal（ESC + 遮罩关闭由 Modal 自动处理）
   - 表单字段改用 ui/FormRow（替代 .provider-form-row + .provider-form-label）
   数据源：useChatStore（providers / addProvider / editProvider / removeProvider / testProviderConn）
   ===================================================================== */

import { useEffect, useState } from 'react';
import { useChatStore } from '../../../store/useChatStore';
import {
  listAIProviderModels,
  exportAIProvidersEncrypted,
  importAIProvidersEncrypted,
  // v0.5.2 B-4：文件对话框 + 预览导入 + 文件读写
  selectAIProviderExportPath,
  selectAIProviderImportFile,
  writeAIProviderExportFile,
  readAIProviderImportFile,
  previewImportAIProviders,
} from '../../../lib/electron-api';
import type {
  CustomAIProvider,
  CustomAIProviderInput,
} from '../../../lib/electron-api';
import Badge from '../../ui/Badge';
import { Button, IconButton, Modal, SegmentedControl, SectionTitle, FormRow } from '../../ui';
import './ProviderSection.css';

interface ProviderSectionProps {
  /** 是否默认折叠 */
  defaultCollapsed?: boolean;
}

/** v0.5.2 regress-1：供应商来源预设 */
const PRESETS: Array<{ id: string; label: string; protocol: 'openai' | 'anthropic' | 'custom'; endpoint: string; model: string }> = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { id: 'qwen', label: '通义千问', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { id: 'kimi', label: 'Kimi', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
];

export default function ProviderSection({ defaultCollapsed = true }: ProviderSectionProps) {
  const {
    providers,
    loadingProviders,
    initProviders,
    addProvider,
    editProvider,
    removeProvider,
    testProviderConn,
  } = useChatStore();

  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [editing, setEditing] = useState<CustomAIProviderInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  // v0.5.2 regress-4：API Key 显隐切换（眼睛图标）
  const [showApiKey, setShowApiKey] = useState(false);

  // 需求 9：模型搜索 combobox 状态
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [searchingModels, setSearchingModels] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // v0.5.2 B-4：加密导出 / 导入状态（文件对话框 + 选择性导出 + 预览导入）
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(new Set());
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [importFilePath, setImportFilePath] = useState('');
  const [importPreview, setImportPreview] = useState<{
    providers: Array<{ id: string; name: string; protocol: string; apiEndpoint: string; model: string; alternativeModels?: string[] }>;
    conflictIds: string[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [cryptoFeedback, setCryptoFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    void initProviders();
  }, [initProviders]);

  const handleAdd = () => {
    setEditing({
      name: '',
      protocol: 'openai',
      apiEndpoint: '',
      apiKey: '',
      model: '',
      alternativeModels: [],
      ttsEnabled: false,
      ttsModel: '',
      sttEnabled: false,
      sttModel: '',
    });
    setEditingId(null);
    setTestResult(null);
  };

  const handleEdit = (p: CustomAIProvider) => {
    setEditing({
      name: p.name,
      protocol: p.protocol,
      apiEndpoint: p.apiEndpoint,
      apiKey: p.apiKey,
      model: p.model,
      // v0.5.2 regress-1：加载备选模型列表
      alternativeModels: p.alternativeModels ?? [],
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      ttsEnabled: p.ttsEnabled ?? false,
      ttsModel: p.ttsModel ?? '',
      sttEnabled: p.sttEnabled ?? false,
      sttModel: p.sttModel ?? '',
    });
    setEditingId(p.id);
    setTestResult(null);
  };

  const handleDelete = async (id: string) => {
    await removeProvider(id);
  };

  const updateField = <K extends keyof CustomAIProviderInput,>(key: K, value: CustomAIProviderInput[K]) => {
    setEditing((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProviderConn(editing);
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.apiEndpoint.trim() || !editing.model.trim()) {
      setTestResult({ ok: false, message: '名称、API 端点、模型均为必填项' });
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await editProvider(editingId, editing);
      } else {
        await addProvider(editing);
      }
      setEditing(null);
      setEditingId(null);
      setTestResult(null);
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditing(null);
    setEditingId(null);
    setTestResult(null);
    setModelCandidates([]);
    setShowModelDropdown(false);
  };

  // 需求 9：搜索 Provider 可用模型列表
  const handleSearchModels = async (overrideInput?: CustomAIProviderInput) => {
    const input = overrideInput ?? editing;
    if (!input) return;
    if (!input.apiEndpoint.trim() || !input.apiKey.trim()) {
      setTestResult({ ok: false, message: '请先填写 API 端点和密钥' });
      return;
    }
    setSearchingModels(true);
    setShowModelDropdown(true);
    try {
      const models = await listAIProviderModels(input);
      setModelCandidates(models);
      if (models.length === 0) {
        setTestResult({ ok: false, message: '未找到模型（协议可能不支持 /v1/models，请手动输入）' });
      }
    } catch (e) {
      setModelCandidates([]);
      setTestResult({ ok: false, message: `搜索失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSearchingModels(false);
    }
  };

  // 应用预设：填入 endpoint + 默认 model + 协议，并触发模型搜索
  const handleApplyPreset = (preset: typeof PRESETS[number]) => {
    if (!editing) return;
    const next: CustomAIProviderInput = {
      ...editing,
      protocol: preset.protocol,
      apiEndpoint: preset.endpoint,
      model: preset.model,
      alternativeModels: [],
    };
    setEditing(next);
    // 仅当 apiKey 已填时才触发搜索（否则提示用户先填 apiKey）
    if (next.apiKey.trim()) {
      void handleSearchModels(next);
    }
  };

  // v0.5.2 regress-1：勾选/取消勾选模型
  const handleToggleModel = (modelName: string, checked: boolean) => {
    if (!editing) return;
    if (checked) {
      // 勾选：若主模型为空则设为主模型；否则加入 alternativeModels（去重）
      if (!editing.model) {
        updateField('model', modelName);
      } else if (editing.model === modelName) {
        // 已是主模型，无需再加
        return;
      } else if (!editing.alternativeModels?.includes(modelName)) {
        updateField('alternativeModels', [...(editing.alternativeModels ?? []), modelName]);
      }
    } else {
      // 取消勾选
      if (editing.model === modelName) {
        // 取消主模型：将第一个备选提升为主模型
        const alts = editing.alternativeModels ?? [];
        if (alts.length > 0) {
          const [newMain, ...rest] = alts;
          setEditing({ ...editing, model: newMain, alternativeModels: rest });
        } else {
          updateField('model', '');
        }
      } else {
        updateField('alternativeModels', (editing.alternativeModels ?? []).filter((m) => m !== modelName));
      }
    }
  };

  // 移除已选模型 Chip
  const handleRemoveModelChip = (modelName: string) => {
    if (!editing) return;
    if (editing.model === modelName) {
      const alts = editing.alternativeModels ?? [];
      if (alts.length > 0) {
        const [newMain, ...rest] = alts;
        setEditing({ ...editing, model: newMain, alternativeModels: rest });
      } else {
        updateField('model', '');
      }
    } else {
      updateField('alternativeModels', (editing.alternativeModels ?? []).filter((m) => m !== modelName));
    }
  };

  // 主模型 input 失焦：若值与某个备选重复，则从备选移除
  const handleModelInputBlur = () => {
    if (!editing) return;
    if (editing.model && editing.alternativeModels?.includes(editing.model)) {
      updateField('alternativeModels', editing.alternativeModels.filter((m) => m !== editing.model));
    }
  };

  // v0.5.2 B-4：加密导出（文件对话框 + 选择性导出）
  const handleStartExport = () => {
    setExportPassword('');
    setExportDialogOpen(true);
  };
  const handleConfirmExport = async () => {
    if (!exportPassword.trim()) {
      setCryptoFeedback({ type: 'error', msg: '请输入导出密码' });
      return;
    }
    setExporting(true);
    try {
      const ids = Array.from(selectedExportIds);
      const cipher = await exportAIProvidersEncrypted(
        exportPassword,
        ids.length > 0 ? ids : undefined,
      );
      const filePath = await selectAIProviderExportPath();
      if (!filePath) {
        // 用户取消，保留对话框内容
        return;
      }
      const result = await writeAIProviderExportFile(filePath, cipher);
      if (result.ok) {
        setCryptoFeedback({
          type: 'success',
          msg: `已导出 ${ids.length > 0 ? ids.length : providers.length} 个 Provider 到 ${filePath}`,
        });
        setExportDialogOpen(false);
        setExportPassword('');
        setSelectedExportIds(new Set());
      } else {
        setCryptoFeedback({ type: 'error', msg: `写入文件失败：${result.error}` });
      }
    } catch (e) {
      setCryptoFeedback({ type: 'error', msg: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setExporting(false);
    }
  };

  // v0.5.2 B-4：加密导入（文件选择 → 密码 → 预览 → 确认）
  const handleStartImport = () => {
    setImportFilePath('');
    setImportPassword('');
    setImportPreview(null);
    setImportDialogOpen(true);
  };
  const handleSelectImportFile = async () => {
    const filePath = await selectAIProviderImportFile();
    if (filePath) setImportFilePath(filePath);
  };
  const handlePreviewImport = async () => {
    if (!importFilePath || !importPassword) return;
    setImporting(true);
    try {
      const readResult = await readAIProviderImportFile(importFilePath);
      if (!readResult.ok || !readResult.content) {
        setCryptoFeedback({ type: 'error', msg: `读取文件失败：${readResult.error}` });
        return;
      }
      const preview = await previewImportAIProviders(readResult.content, importPassword);
      if (!preview.ok) {
        setCryptoFeedback({ type: 'error', msg: `解析失败：${preview.error}` });
        return;
      }
      setImportPreview({
        providers: preview.providers ?? [],
        conflictIds: preview.conflictIds ?? [],
      });
    } catch (e) {
      setCryptoFeedback({ type: 'error', msg: `预览失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setImporting(false);
    }
  };
  const handleConfirmImport = async () => {
    if (!importFilePath || !importPassword || !importPreview) return;
    setImporting(true);
    try {
      const readResult = await readAIProviderImportFile(importFilePath);
      if (!readResult.ok || !readResult.content) {
        setCryptoFeedback({ type: 'error', msg: `读取文件失败：${readResult.error}` });
        return;
      }
      const result = await importAIProvidersEncrypted(readResult.content, importPassword);
      if (result.ok) {
        setCryptoFeedback({
          type: 'success',
          msg: `已导入 ${importPreview.providers.length} 个 Provider`,
        });
        setImportDialogOpen(false);
        setImportFilePath('');
        setImportPassword('');
        setImportPreview(null);
        await initProviders();
      } else {
        setCryptoFeedback({ type: 'error', msg: `导入失败：${result.error || '未知错误'}` });
      }
    } catch (e) {
      setCryptoFeedback({ type: 'error', msg: `导入失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setImporting(false);
    }
  };

  // v0.5.2 B-4：切换单个 provider 的导出选中状态
  const handleToggleExportSelect = (id: string, checked: boolean) => {
    setSelectedExportIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  // v0.5.2 B-4：全选/全不选
  const handleToggleSelectAll = (checked: boolean) => {
    setSelectedExportIds(checked ? new Set(providers.map((p) => p.id)) : new Set());
  };

  return (
    <section data-name="settings.provider.section">
      <SectionTitle
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        data-name="settings.provider.title-row"
      >
        供应商管理（{providers.length}）
      </SectionTitle>

      {!collapsed && (
        <>
          {loadingProviders && providers.length === 0 && (
            <div className="ai-app-tab-hint" data-name="settings.provider.loading">正在加载...</div>
          )}

          {/* 供应商卡片列表 */}
          {providers.map((p, idx) => (
            <div className="provider-card" key={p.id} data-name={`ai-app-provider.provider-card-${idx + 1}`} data-index={idx + 1} data-id={p.id}>
              <div className="provider-card-head" data-name={`ai-app-provider.provider-card-${idx + 1}-head`}>
                <span className="provider-card-name" data-name={`ai-app-provider.provider-card-${idx + 1}-name`}>{p.name}</span>
                <Badge variant="accent" data-name={`ai-app-provider.provider-card-${idx + 1}-protocol-badge`}>{p.protocol}</Badge>
                {!editing && (
                  <label
                    className="provider-card-export-check"
                    title="勾选后点加密导出，仅导出选中项"
                    data-name={`ai-app-provider.provider-card-${idx + 1}-export-check-label`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedExportIds.has(p.id)}
                      onChange={(e) => handleToggleExportSelect(p.id, e.target.checked)}
                      data-name={`ai-app-provider.provider-card-${idx + 1}-export-check-input`}
                    />
                  </label>
                )}
              </div>
              <div className="provider-card-model" data-name={`ai-app-provider.provider-card-${idx + 1}-model`}>模型：{p.model}</div>
              <div className="provider-card-endpoint" title={p.apiEndpoint} data-name={`ai-app-provider.provider-card-${idx + 1}-endpoint`}>{p.apiEndpoint}</div>
              <div className="provider-card-actions" data-name={`ai-app-provider.provider-card-${idx + 1}-actions`}>
                <Button type="button" variant="text" className="provider-action-btn" onClick={() => handleEdit(p)} data-name={`ai-app-provider.provider-card-${idx + 1}-edit-button`}>编辑</Button>
                <Button type="button" variant="text" danger className="provider-action-btn danger" onClick={() => void handleDelete(p.id)} data-name={`ai-app-provider.provider-card-${idx + 1}-delete-button`}>删除</Button>
              </div>
            </div>
          ))}

          {/* v0.5.2 B-4：加密导出 / 导入工具栏（卡片列表下方） */}
          {!editing && (
            <div className="provider-crypto-panel v2" data-name="ai-app-provider.crypto-panel">
              <div className="provider-crypto-toolbar" data-name="ai-app-provider.crypto-toolbar">
                <label className="provider-crypto-select-all" data-name="ai-app-provider.crypto-select-all">
                  <input
                    type="checkbox"
                    checked={selectedExportIds.size === providers.length && providers.length > 0}
                    onChange={(e) => handleToggleSelectAll(e.target.checked)}
                    disabled={providers.length === 0}
                    data-name="ai-app-provider.crypto-select-all-input"
                  />
                  <span>全选</span>
                </label>
                <Button
                  type="button"
                  variant="text"
                  onClick={handleStartExport}
                  disabled={providers.length === 0 && selectedExportIds.size === 0}
                  data-name="ai-app-provider.crypto-export-button"
                  className="provider-crypto-action-btn"
                >
                  {selectedExportIds.size > 0
                    ? `加密导出选中（${selectedExportIds.size}）`
                    : providers.length > 0 ? '加密导出全部' : '无供应商可导出'}
                </Button>
                <Button
                  type="button"
                  variant="text"
                  onClick={handleStartImport}
                  data-name="ai-app-provider.crypto-import-button"
                  className="provider-crypto-action-btn"
                >
                  加密导入
                </Button>
              </div>
            </div>
          )}

          {/* 新建按钮（表单未打开时显示） */}
          {!editing && (
            <Button type="button" variant="ghost" className="provider-add-btn" onClick={handleAdd} data-name="ai-app-provider.provider-add-button">+ 添加自定义供应商</Button>
          )}
        </>
      )}

      {/* 编辑/新建表单（Modal 替代原 .provider-edit-overlay） */}
      <Modal
        open={editing !== null}
        onClose={handleCancel}
        title="编辑供应商"
        className="provider-edit-modal"
        data-name="ai-app-provider.provider-form"
      >
        {editing && (
          <>
            <FormRow label="名称" stack data-name="ai-app-provider.provider-form-name-row">
              <input
                type="text"
                className="provider-form-input"
                value={editing.name}
                placeholder="My OpenAI"
                spellCheck={false}
                autoComplete="off"
                data-name="ai-app-provider.provider-form-name-input"
                onChange={(e) => updateField('name', e.target.value)}
              />
            </FormRow>
            <FormRow label="协议" stack data-name="ai-app-provider.provider-form-protocol-row">
              <select
                className="provider-form-input"
                value={editing.protocol}
                data-name="ai-app-provider.provider-form-protocol-select"
                onChange={(e) => updateField('protocol', e.target.value as CustomAIProvider['protocol'])}
              >
                <option value="openai" data-name="ai-app-provider.provider-form-protocol-option-1">openai</option>
                <option value="anthropic" data-name="ai-app-provider.provider-form-protocol-option-2">anthropic</option>
                <option value="custom" data-name="ai-app-provider.provider-form-protocol-option-3">custom</option>
              </select>
            </FormRow>
            {/* v0.5.2 regress-1：供应商来源预设 Chip */}
            <FormRow label="供应商来源预设" stack data-name="ai-app-provider.provider-form-preset-row">
              <div className="provider-preset-chips" data-name="ai-app-provider.provider-form-preset-chips">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`provider-preset-chip${editing.apiEndpoint === preset.endpoint ? ' active' : ''}`}
                    onClick={() => handleApplyPreset(preset)}
                    title={`${preset.endpoint} · ${preset.model}`}
                    data-name={`ai-app-provider.provider-form-preset-chip-${preset.id}`}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="provider-preset-chip"
                  onClick={() => {
                    if (!editing) return;
                    setEditing({ ...editing, apiEndpoint: '', model: '', alternativeModels: [] });
                  }}
                  title="清空 endpoint 和 model，手动配置"
                  data-name="ai-app-provider.provider-form-preset-chip-custom"
                >
                  自定义
                </button>
              </div>
            </FormRow>
            <FormRow label="API 端点" stack data-name="ai-app-provider.provider-form-endpoint-row">
              <input
                type="text"
                className="provider-form-input"
                value={editing.apiEndpoint}
                placeholder="https://api.openai.com/v1/chat/completions"
                spellCheck={false}
                autoComplete="off"
                data-name="ai-app-provider.provider-form-endpoint-input"
                onChange={(e) => updateField('apiEndpoint', e.target.value)}
              />
            </FormRow>
            <FormRow label="API 密钥" stack data-name="ai-app-provider.provider-form-api-key-row">
              <div className="provider-api-key-wrapper" data-name="ai-app-provider.provider-form-api-key-wrapper">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  className="provider-form-input"
                  value={editing.apiKey}
                  placeholder="sk-..."
                  spellCheck={false}
                  autoComplete="off"
                  data-name="ai-app-provider.provider-form-api-key-input"
                  onChange={(e) => updateField('apiKey', e.target.value)}
                />
                <IconButton
                  type="button"
                  className="provider-api-key-toggle"
                  aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                  title={showApiKey ? '隐藏密钥' : '显示密钥'}
                  data-name="ai-app-provider.provider-form-api-key-toggle"
                  onClick={() => setShowApiKey((v) => !v)}
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
            <FormRow label="模型" stack data-name="ai-app-provider.provider-form-model-row">
              <div className="provider-model-combobox" data-name="ai-app-provider.provider-form-model-combobox">
                <input
                  type="text"
                  className="provider-form-input"
                  value={editing.model}
                  placeholder="gpt-4o-mini（主模型）"
                  spellCheck={false}
                  autoComplete="off"
                  data-name="ai-app-provider.provider-form-model-input"
                  onChange={(e) => updateField('model', e.target.value)}
                  onFocus={() => setShowModelDropdown(true)}
                  onBlur={() => {
                    setTimeout(() => setShowModelDropdown(false), 200);
                    handleModelInputBlur();
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  className="provider-model-search-btn"
                  disabled={searchingModels}
                  onClick={() => void handleSearchModels()}
                  data-name="ai-app-provider.provider-form-model-search-button"
                >
                  {searchingModels ? '搜索中…' : '搜索模型'}
                </Button>
                {showModelDropdown && modelCandidates.length > 0 && (
                  <ul className="provider-model-dropdown" data-name="ai-app-provider.provider-form-model-dropdown">
                    {modelCandidates.map((m) => {
                      const isMain = editing.model === m;
                      const isAlt = editing.alternativeModels?.includes(m) ?? false;
                      const checked = isMain || isAlt;
                      return (
                        <li
                          key={m}
                          className="provider-model-option-row"
                          data-name={`ai-app-provider.provider-form-model-option-${m}`}
                        >
                          <label>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => handleToggleModel(m, e.target.checked)}
                            />
                            <span className="provider-model-option-label">{m}</span>
                            {isMain && <span className="provider-model-option-tag">主</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              {/* v0.5.2 regress-1：已选模型 Chip 展示 */}
              {(editing.model || (editing.alternativeModels?.length ?? 0) > 0) && (
                <div className="provider-model-chips" data-name="ai-app-provider.provider-form-model-chips">
                  {editing.model && (
                    <span className="provider-model-chip main" data-name="ai-app-provider.provider-form-model-chip-main">
                      {editing.model}
                      <button
                        type="button"
                        className="provider-model-chip-remove"
                        aria-label="移除主模型"
                        onClick={() => handleRemoveModelChip(editing.model)}
                        data-name="ai-app-provider.provider-form-model-chip-main-remove"
                      >×</button>
                    </span>
                  )}
                  {(editing.alternativeModels ?? []).map((m) => (
                    <span key={m} className="provider-model-chip" data-name={`ai-app-provider.provider-form-model-chip-${m}`}>
                      {m}
                      <button
                        type="button"
                        className="provider-model-chip-remove"
                        aria-label={`移除 ${m}`}
                        onClick={() => handleRemoveModelChip(m)}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
            </FormRow>
            <FormRow label="温度" hint="0~2，可选" stack data-name="ai-app-provider.provider-form-temperature-row">
              <input
                type="number"
                className="provider-form-input"
                value={editing.temperature ?? ''}
                min={0}
                max={2}
                step={0.1}
                placeholder="0.7"
                data-name="ai-app-provider.provider-form-temperature-input"
                onChange={(e) => {
                  const v = e.target.value;
                  updateField('temperature', v === '' ? undefined : Number(v));
                }}
              />
            </FormRow>
            <FormRow label="最大 token" hint="可选" stack data-name="ai-app-provider.provider-form-max-tokens-row">
              <input
                type="number"
                className="provider-form-input"
                value={editing.maxTokens ?? ''}
                min={1}
                placeholder="4096"
                data-name="ai-app-provider.provider-form-max-tokens-input"
                onChange={(e) => {
                  const v = e.target.value;
                  updateField('maxTokens', v === '' ? undefined : Number(v));
                }}
              />
            </FormRow>
            <FormRow label="语音配置" stack data-name="ai-app-provider.provider-form-voice-row">
              <div className="provider-voice-section">
                <div className="provider-voice-row">
                  <span className="provider-voice-label">TTS（文本转语音）</span>
                  <SegmentedControl
                    value={editing.ttsEnabled ? 'on' : 'off'}
                    onChange={(v) => setEditing({ ...editing, ttsEnabled: v === 'on' })}
                    name="tts-toggle"
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'on', label: '启用' },
                    ]}
                  />
                  {editing.ttsEnabled && (
                    <input
                      type="text"
                      value={editing.ttsModel}
                      onChange={(e) => setEditing({ ...editing, ttsModel: e.target.value })}
                      placeholder="tts-1"
                      className="provider-form-input"
                    />
                  )}
                </div>
                <div className="provider-voice-row">
                  <span className="provider-voice-label">STT（语音转文本）</span>
                  <SegmentedControl
                    value={editing.sttEnabled ? 'on' : 'off'}
                    onChange={(v) => setEditing({ ...editing, sttEnabled: v === 'on' })}
                    name="stt-toggle"
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'on', label: '启用' },
                    ]}
                  />
                  {editing.sttEnabled && (
                    <input
                      type="text"
                      value={editing.sttModel}
                      onChange={(e) => setEditing({ ...editing, sttModel: e.target.value })}
                      placeholder="whisper-1"
                      className="provider-form-input"
                    />
                  )}
                </div>
              </div>
            </FormRow>
            {testResult && (
              <div className={`provider-test-result ${testResult.ok ? 'ok' : 'fail'}`} data-name="ai-app-provider.provider-form-test-result">
                {testResult.ok ? '连通正常' : '连通失败'}：{testResult.message}
                {typeof testResult.latencyMs === 'number' ? `（${testResult.latencyMs}ms）` : ''}
              </div>
            )}
            <div className="provider-form-actions" data-name="ai-app-provider.provider-form-actions">
              <Button type="button" variant="ghost" className="provider-form-btn" disabled={testing || saving} onClick={() => void handleTest()} data-name="ai-app-provider.provider-form-test-button">
                {testing ? '测试中…' : '测试连通性'}
              </Button>
              <Button type="button" variant="primary-compact" className="provider-form-btn primary" disabled={testing || saving} onClick={() => void handleSave()} data-name="ai-app-provider.provider-form-save-button">
                {saving ? '保存中…' : '保存'}
              </Button>
              <Button type="button" variant="ghost" className="provider-form-btn" disabled={testing || saving} onClick={handleCancel} data-name="ai-app-provider.provider-form-cancel-button">取消</Button>
            </div>
          </>
        )}
      </Modal>

      {/* 加密导出对话框（Modal 替代原 .provider-form-overlay） */}
      <Modal
        open={exportDialogOpen}
        onClose={() => !exporting && setExportDialogOpen(false)}
        title="加密导出"
        className="provider-crypto-modal"
        data-name="ai-app-provider.export-dialog"
      >
        <p className="provider-form-dialog-desc" data-name="ai-app-provider.export-dialog-desc">
          {selectedExportIds.size > 0
            ? `将导出 ${selectedExportIds.size} 个选中的 Provider 到 .sapp 文件。请输入加密密码（导入时需要使用）。`
            : `将导出全部 ${providers.length} 个 Provider 到 .sapp 文件。请输入加密密码（导入时需要使用）。`}
        </p>
        <input
          type="password"
          className="provider-form-input"
          placeholder="加密密码"
          value={exportPassword}
          onChange={(e) => setExportPassword(e.target.value)}
          autoFocus
          autoComplete="off"
          data-name="ai-app-provider.export-dialog-password-input"
        />
        {cryptoFeedback && (
          <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="ai-app-provider.crypto-feedback">
            {cryptoFeedback.msg}
          </div>
        )}
        <div className="provider-form-actions" data-name="ai-app-provider.export-dialog-actions">
          <Button
            type="button"
            variant="text"
            className="provider-form-btn"
            disabled={exporting}
            onClick={() => setExportDialogOpen(false)}
            data-name="ai-app-provider.export-dialog-cancel-button"
          >
            取消
          </Button>
          <Button
            type="button"
            variant="primary-compact"
            className="provider-form-btn primary"
            disabled={!exportPassword.trim() || exporting}
            onClick={() => void handleConfirmExport()}
            data-name="ai-app-provider.export-dialog-confirm-button"
          >
            {exporting ? '导出中…' : '确认导出'}
          </Button>
        </div>
      </Modal>

      {/* 加密导入对话框（Modal 替代原 .provider-form-overlay） */}
      <Modal
        open={importDialogOpen}
        onClose={() => !importing && setImportDialogOpen(false)}
        title="加密导入"
        className="provider-crypto-modal"
        data-name="ai-app-provider.import-dialog"
      >
        {!importPreview ? (
          <>
            <p className="provider-form-dialog-desc" data-name="ai-app-provider.import-dialog-step1-desc">
              选择 .sapp 文件并输入密码以预览导入内容。
            </p>
            <div className="provider-import-file-row" data-name="ai-app-provider.import-dialog-file-row">
              <input
                type="text"
                className="provider-form-input"
                value={importFilePath}
                readOnly
                placeholder="选择 .sapp 文件..."
                data-name="ai-app-provider.import-dialog-file-input"
              />
              <Button
                type="button"
                variant="text"
                onClick={() => void handleSelectImportFile()}
                data-name="ai-app-provider.import-dialog-select-file-button"
              >
                选择文件
              </Button>
            </div>
            <input
              type="password"
              className="provider-form-input"
              placeholder="解密密码"
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
              autoComplete="off"
              data-name="ai-app-provider.import-dialog-password-input"
            />
            {cryptoFeedback && (
              <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="ai-app-provider.crypto-feedback">
                {cryptoFeedback.msg}
              </div>
            )}
            <div className="provider-form-actions" data-name="ai-app-provider.import-dialog-step1-actions">
              <Button
                type="button"
                variant="text"
                className="provider-form-btn"
                disabled={importing}
                onClick={() => setImportDialogOpen(false)}
                data-name="ai-app-provider.import-dialog-cancel-button"
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary-compact"
                className="provider-form-btn primary"
                disabled={!importFilePath || !importPassword.trim() || importing}
                onClick={() => void handlePreviewImport()}
                data-name="ai-app-provider.import-dialog-preview-button"
              >
                {importing ? '解析中…' : '预览'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="provider-form-dialog-desc" data-name="ai-app-provider.import-dialog-step2-desc">
              将导入 {importPreview.providers.length} 个 Provider，其中 {importPreview.conflictIds.length} 个会覆盖现有配置。
            </p>
            <div className="provider-import-preview-list" data-name="ai-app-provider.import-dialog-preview-list">
              {importPreview.providers.map((p, idx) => {
                const isConflict = importPreview.conflictIds.includes(p.id);
                return (
                  <div
                    key={p.id}
                    className={`provider-import-preview-item ${isConflict ? 'conflict' : 'new'}`}
                    data-name={`ai-app-provider.import-dialog-preview-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={p.id}
                  >
                    <span className="provider-import-preview-name" data-name={`ai-app-provider.import-dialog-preview-item-${idx + 1}-name`}>{p.name}</span>
                    <span className="provider-import-preview-meta" data-name={`ai-app-provider.import-dialog-preview-item-${idx + 1}-meta`}>{p.protocol} · {p.model}</span>
                    <span className="provider-import-preview-tag" data-name={`ai-app-provider.import-dialog-preview-item-${idx + 1}-tag`}>
                      {isConflict ? '覆盖' : '新增'}
                    </span>
                  </div>
                );
              })}
            </div>
            {cryptoFeedback && (
              <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="ai-app-provider.crypto-feedback">
                {cryptoFeedback.msg}
              </div>
            )}
            <div className="provider-form-actions" data-name="ai-app-provider.import-dialog-step2-actions">
              <Button
                type="button"
                variant="text"
                className="provider-form-btn"
                disabled={importing}
                onClick={() => setImportPreview(null)}
                data-name="ai-app-provider.import-dialog-back-button"
              >
                返回
              </Button>
              <Button
                type="button"
                variant="primary-compact"
                className="provider-form-btn primary"
                disabled={importing}
                onClick={() => void handleConfirmImport()}
                data-name="ai-app-provider.import-dialog-confirm-button"
              >
                {importing ? '导入中…' : '确认导入'}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </section>
  );
}
