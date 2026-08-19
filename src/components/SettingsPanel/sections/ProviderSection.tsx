/* =====================================================================
   SettingsPanel/sections/ProviderSection —— 自定义 AI 供应商管理分区
   从 pages/AdvancedPanelView.tsx 的 ProvidersModal 迁移而来。
   - 外层 SectionTitle collapsible（替代 .providers-modal-header）
   - J1：供应商列表改为紧凑单列行风格（.provider-row，参考 PresetSection）
   - 编辑表单 / 加密导出 / 加密导入 改用 ui/Modal（ESC + 遮罩关闭由 Modal 自动处理）
   - 表单字段改用 ui/FormRow（替代 .provider-form-row + .provider-form-label）
   数据源：useChatStore（providers / addProvider / editProvider / removeProvider / testProviderConn）

   重构（拆分）：本文件仅作为有状态容器，负责管理所有状态与副作用；
   纯数据/逻辑拆分到 provider/presets.ts，展示拆分为：
   - provider/ProviderList.tsx（列表 + 加密导出/导入工具栏）
   - provider/ProviderEditForm.tsx（编辑/新建表单 Modal）
   - provider/ExportProviderDialog.tsx（加密导出对话框）
   - provider/ImportProviderDialog.tsx（加密导入对话框）
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
import { SectionTitle } from '../../ui';
import ProviderList from './provider/ProviderList.js';
import ProviderEditForm from './provider/ProviderEditForm.js';
import type { TestResult } from './provider/ProviderEditForm.js';
import ExportProviderDialog from './provider/ExportProviderDialog.js';
import type { CryptoFeedback } from './provider/ExportProviderDialog.js';
import ImportProviderDialog from './provider/ImportProviderDialog.js';
import type { ImportPreview } from './provider/ImportProviderDialog.js';
import { detectProtocol } from './provider/presets.js';
import type { ProviderPreset } from './provider/presets.js';
import './ProviderSection.css';

interface ProviderSectionProps {
  /** 是否默认折叠 */
  defaultCollapsed?: boolean;
  /** 标题是否可折叠（在进阶配置内使用时设为 false，避免二次折叠） */
  collapsibleTitle?: boolean;
  /**
   * 编辑状态变化回调（editing 从 null 变为非 null，或从非 null 变为 null 时触发）。
   *
   * 用途：进阶面板中，编辑供应商时需关闭侧滑面板，让编辑 Modal 全屏覆盖进阶面板。
   * 侧滑面板的 transform 会破坏内部 Modal 的 fixed 定位，故编辑时必须关闭侧滑面板，
   * Modal 通过 portal 渲染到 document.body 确保脱离 transform 影响。
   */
  onEditingChange?: (editing: boolean) => void;
}

export default function ProviderSection({ defaultCollapsed = true, collapsibleTitle = true, onEditingChange }: ProviderSectionProps) {
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
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  // v0.5.2 regress-4：API Key 显隐切换（眼睛图标）
  const [showApiKey, setShowApiKey] = useState(false);

  // 需求 9：模型搜索 combobox 状态
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [searchingModels, setSearchingModels] = useState(false);
  // 下拉开关：主模型 / TTS / STT 三处下拉独立控制
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showTtsDropdown, setShowTtsDropdown] = useState(false);
  const [showSttDropdown, setShowSttDropdown] = useState(false);
  // TTS/STT 自动搜索状态：开关打开时若 modelCandidates 为空，自动触发搜索
  const [autoSearchingTts, setAutoSearchingTts] = useState(false);
  const [autoSearchingStt, setAutoSearchingStt] = useState(false);

  // v0.5.2 B-4：加密导出 / 导入状态（文件对话框 + 选择性导出 + 预览导入）
  const [selectedExportIds, setSelectedExportIds] = useState<Set<string>>(new Set());
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [importFilePath, setImportFilePath] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [cryptoFeedback, setCryptoFeedback] = useState<CryptoFeedback | null>(null);

  useEffect(() => {
    void initProviders();
  }, [initProviders]);

  // 注：下拉框 ESC 关闭由 ui/Combobox 内部 useEscToCloseOverlay 处理，不再此处监听

  // 编辑状态变化时通知父组件（进阶面板用于关闭侧滑面板，让编辑 Modal 全屏覆盖）
  useEffect(() => {
    onEditingChange?.(editing !== null);
  }, [editing, onEditingChange]);

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
      setModelCandidates([]);
      setShowModelDropdown(false);
      setShowTtsDropdown(false);
      setShowSttDropdown(false);
      setAutoSearchingTts(false);
      setAutoSearchingStt(false);
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
    setShowTtsDropdown(false);
    setShowSttDropdown(false);
    setAutoSearchingTts(false);
    setAutoSearchingStt(false);
  };

  // 需求 9：搜索 Provider 可用模型列表（不要求 API Key）
  const handleSearchModels = async (overrideInput?: CustomAIProviderInput) => {
    const input = overrideInput ?? editing;
    if (!input) return;
    if (!input.apiEndpoint.trim()) {
      setTestResult({ ok: false, message: '请先填写 API 端点' });
      return;
    }
    setSearchingModels(true);
    setShowModelDropdown(true);
    try {
      const models = await listAIProviderModels(input);
      setModelCandidates(models);
      if (models.length === 0) {
        setTestResult({ ok: false, message: '未找到模型（该端点可能不支持 /v1/models，请手动输入模型名）' });
      } else {
        setTestResult(null);
      }
    } catch (e) {
      setModelCandidates([]);
      setTestResult({ ok: false, message: `搜索失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSearchingModels(false);
    }
  };

  // 语音模型候选：展示所有 modelCandidates，不筛选
  // 但自动匹配时优先选择包含 TTS/STT 关键词的模型
  const isTtsModel = (m: string): boolean => /tts/i.test(m);
  const isSttModel = (m: string): boolean => /stt|whisper/i.test(m);

  // TTS 开关切换：开启时若 modelCandidates 为空，自动触发搜索；
  // 搜索完成后若有匹配的 TTS 模型且当前 ttsModel 为空，自动填入第一个候选；
  // 无论是否匹配到候选，都展开下拉（让用户看到搜索结果或手动输入）
  const handleTtsToggle = async (v: string) => {
    if (!editing) return;
    const enabled = v === 'on';
    if (!enabled) {
      setEditing({ ...editing, ttsEnabled: false });
      setShowTtsDropdown(false);
      return;
    }
    // 开启 TTS：若 modelCandidates 为空，自动搜索
    if (modelCandidates.length === 0) {
      setEditing({ ...editing, ttsEnabled: true });
      setAutoSearchingTts(true);
      setShowTtsDropdown(true); // 立即展开下拉显示 loading
      try {
        const models = await listAIProviderModels(editing);
        setModelCandidates(models);
        // 自动填入第一个匹配 TTS 关键词的模型（若有）
        const ttsMatch = models.find((m) => isTtsModel(m));
        if (ttsMatch && !editing.ttsModel) {
          setEditing((prev) => prev ? { ...prev, ttsModel: ttsMatch } : prev);
        }
        // 保持下拉展开，让用户看到候选列表
      } catch (e) {
        setTestResult({ ok: false, message: `TTS 模型搜索失败：${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setAutoSearchingTts(false);
      }
    } else {
      // 已有候选，自动填入第一个匹配 TTS 关键词的模型（若 ttsModel 为空）
      const ttsMatch = modelCandidates.find((m) => isTtsModel(m));
      setEditing({
        ...editing,
        ttsEnabled: true,
        ttsModel: editing.ttsModel || ttsMatch || '',
      });
      setShowTtsDropdown(true); // 总是展开下拉
    }
  };

  // STT 开关切换：开启时若 modelCandidates 为空，自动触发搜索；
  // 搜索完成后若有匹配的 STT 模型且当前 sttModel 为空，自动填入第一个候选；
  // 无论是否匹配到候选，都展开下拉（让用户看到搜索结果或手动输入）
  const handleSttToggle = async (v: string) => {
    if (!editing) return;
    const enabled = v === 'on';
    if (!enabled) {
      setEditing({ ...editing, sttEnabled: false });
      setShowSttDropdown(false);
      return;
    }
    // 开启 STT：若 modelCandidates 为空，自动搜索
    if (modelCandidates.length === 0) {
      setEditing({ ...editing, sttEnabled: true });
      setAutoSearchingStt(true);
      setShowSttDropdown(true); // 立即展开下拉显示 loading
      try {
        const models = await listAIProviderModels(editing);
        setModelCandidates(models);
        // 自动填入第一个匹配 STT/whisper 关键词的模型（若有）
        const sttMatch = models.find((m) => isSttModel(m));
        if (sttMatch && !editing.sttModel) {
          setEditing((prev) => prev ? { ...prev, sttModel: sttMatch } : prev);
        }
        // 保持下拉展开，让用户看到候选列表
      } catch (e) {
        setTestResult({ ok: false, message: `STT 模型搜索失败：${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setAutoSearchingStt(false);
      }
    } else {
      // 已有候选，自动填入第一个匹配 STT 关键词的模型（若 sttModel 为空）
      const sttMatch = modelCandidates.find((m) => isSttModel(m));
      setEditing({
        ...editing,
        sttEnabled: true,
        sttModel: editing.sttModel || sttMatch || '',
      });
      setShowSttDropdown(true); // 总是展开下拉
    }
  };

  // 应用预设：填入 endpoint + 默认 model，协议由端点自动推断
  const handleApplyPreset = (preset: ProviderPreset) => {
    if (!editing) return;
    const next: CustomAIProviderInput = {
      ...editing,
      protocol: detectProtocol(preset.endpoint),
      apiEndpoint: preset.endpoint,
      model: preset.model,
      alternativeModels: [],
    };
    setEditing(next);
    // 预设应用后自动触发模型搜索（不需要 API Key）
    void handleSearchModels(next);
  };

  // API 端点变化时自动推断协议
  const handleEndpointChange = (value: string) => {
    if (!editing) return;
    const protocol = detectProtocol(value);
    setEditing({ ...editing, apiEndpoint: value, protocol });
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
        collapsible={collapsibleTitle}
        collapsed={collapsibleTitle ? collapsed : false}
        onToggle={collapsibleTitle ? () => setCollapsed((v) => !v) : undefined}
        data-name="settings.provider.title-row"
      >
        供应商管理（{providers.length}）
      </SectionTitle>

      {(!collapsibleTitle || !collapsed) && (
        <>
          {loadingProviders && providers.length === 0 && (
            <div className="advanced-panel-tab-hint" data-name="settings.provider.loading">正在加载...</div>
          )}

          <ProviderList
            providers={providers}
            editing={editing}
            selectedExportIds={selectedExportIds}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onAdd={handleAdd}
            onToggleExportSelect={handleToggleExportSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onStartExport={handleStartExport}
            onStartImport={handleStartImport}
          />
        </>
      )}

      {/* 编辑/新建表单（Modal 替代原 .provider-edit-overlay） */}
      {/* portal=true：渲染到 document.body，脱离侧滑面板 transform 的影响，全屏覆盖进阶面板 */}
      <ProviderEditForm
        editing={editing}
        testing={testing}
        testResult={testResult}
        saving={saving}
        showApiKey={showApiKey}
        onToggleApiKey={() => setShowApiKey((v) => !v)}
        modelCandidates={modelCandidates}
        searchingModels={searchingModels}
        showModelDropdown={showModelDropdown}
        onShowModelDropdownChange={setShowModelDropdown}
        showTtsDropdown={showTtsDropdown}
        onShowTtsDropdownChange={setShowTtsDropdown}
        showSttDropdown={showSttDropdown}
        onShowSttDropdownChange={setShowSttDropdown}
        autoSearchingTts={autoSearchingTts}
        autoSearchingStt={autoSearchingStt}
        onFieldChange={updateField}
        onEndpointChange={handleEndpointChange}
        onApplyPreset={handleApplyPreset}
        onSearchModels={handleSearchModels}
        onTtsToggle={handleTtsToggle}
        onSttToggle={handleSttToggle}
        onToggleModel={handleToggleModel}
        onRemoveModelChip={handleRemoveModelChip}
        isTtsModel={isTtsModel}
        isSttModel={isSttModel}
        onTest={handleTest}
        onSave={handleSave}
        onCancel={handleCancel}
      />

      {/* 加密导出对话框（Modal 替代原 .provider-form-overlay） */}
      <ExportProviderDialog
        open={exportDialogOpen}
        selectedCount={selectedExportIds.size}
        totalCount={providers.length}
        password={exportPassword}
        onPasswordChange={setExportPassword}
        exporting={exporting}
        feedback={cryptoFeedback}
        onClose={() => setExportDialogOpen(false)}
        onConfirm={handleConfirmExport}
      />

      {/* 加密导入对话框（Modal 替代原 .provider-form-overlay） */}
      <ImportProviderDialog
        open={importDialogOpen}
        importing={importing}
        importFilePath={importFilePath}
        importPassword={importPassword}
        importPreview={importPreview}
        feedback={cryptoFeedback}
        onClose={() => setImportDialogOpen(false)}
        onSelectFile={handleSelectImportFile}
        onPasswordChange={setImportPassword}
        onPreview={handlePreviewImport}
        onConfirm={handleConfirmImport}
        onBack={() => setImportPreview(null)}
      />
    </section>
  );
}
