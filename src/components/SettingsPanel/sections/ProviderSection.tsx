/* =====================================================================
   SettingsPanel/sections/ProviderSection —— 自定义 AI 供应商管理分区
   从 pages/AdvancedPanelView.tsx 的 ProvidersModal 迁移而来。
   - 外层 SectionTitle collapsible（替代 .providers-modal-header）
   - J1：供应商列表改为紧凑单列行风格（.provider-row，参考 PresetSection）
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
import { Button, IconButton, Modal, SegmentedControl, SectionTitle, FormRow, Combobox } from '../../ui';
import type { ComboboxOption } from '../../ui';
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

/** 供应商来源预设（2026 热门模型，覆盖国内外主流厂商 + Coding Plan + 聚合平台）
 *  region: 'domestic' 国内 | 'foreign' 国外
 *  region 字段仅作为 tag 显示用，所有预设始终展示（不做过滤）
 */
const PRESETS: Array<{ id: string; label: string; protocol: 'openai' | 'anthropic' | 'custom'; endpoint: string; model: string; region: 'domestic' | 'foreign' }> = [
  // ===== 国际主流 =====
  { id: 'openai', label: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', region: 'foreign' },
  { id: 'anthropic', label: 'Anthropic Claude', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-5', region: 'foreign' },
  { id: 'gemini', label: 'Google Gemini', protocol: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-pro', region: 'foreign' },
  { id: 'groq', label: 'Groq', protocol: 'openai', endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', region: 'foreign' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4o-mini', region: 'foreign' },
  { id: 'together', label: 'Together AI', protocol: 'openai', endpoint: 'https://api.together.xyz/v1/chat/completions', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', region: 'foreign' },
  { id: 'mistral', label: 'Mistral AI', protocol: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-large-latest', region: 'foreign' },
  { id: 'cohere', label: 'Cohere', protocol: 'openai', endpoint: 'https://api.cohere.ai/v1/chat/completions', model: 'command-r-plus', region: 'foreign' },
  { id: 'fireworks', label: 'Fireworks AI', protocol: 'openai', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions', model: 'accounts/fireworks/models/llama-v3p1-70b-instruct', region: 'foreign' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai', endpoint: 'https://api.perplexity.ai/chat/completions', model: 'llama-3.1-sonar-large-32k-online', region: 'foreign' },
  { id: 'xai', label: 'xAI Grok', protocol: 'openai', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-3', region: 'foreign' },
  { id: 'deepinfra', label: 'DeepInfra', protocol: 'openai', endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions', model: 'meta-llama/Llama-3.3-70B-Instruct', region: 'foreign' },
  { id: 'lepton', label: 'Lepton AI', protocol: 'openai', endpoint: 'https://api.lepton.ai/v1/chat/completions', model: 'llama3-70b', region: 'foreign' },
  { id: 'novita', label: 'Novita AI', protocol: 'openai', endpoint: 'https://api.novita.ai/v3/openai/chat/completions', model: 'llama3.1-70b-instruct', region: 'foreign' },
  { id: 'chutes', label: 'Chutes AI', protocol: 'openai', endpoint: 'https://api.chutes.ai/v1/chat/completions', model: 'chutes/llama-3.3-70b', region: 'foreign' },
  // ===== 国内主流 =====
  { id: 'deepseek', label: 'DeepSeek 深度求索', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', region: 'domestic' },
  { id: 'qwen', label: '通义千问 (阿里百炼)', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', region: 'domestic' },
  { id: 'kimi', label: 'Kimi (月之暗面)', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', region: 'domestic' },
  { id: 'zhipu', label: '智谱 GLM', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', region: 'domestic' },
  { id: 'doubao', label: '豆包 (火山方舟)', protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-pro-32k', region: 'domestic' },
  { id: 'ernie', label: '百度文心 ERNIE', protocol: 'openai', endpoint: 'https://qianfan.baidubce.com/v2/chat/completions', model: 'ernie-4.0-8k', region: 'domestic' },
  { id: 'hunyuan', label: '腾讯混元', protocol: 'openai', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-pro', region: 'domestic' },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', endpoint: 'https://api.minimax.chat/v1/chat/completions', model: 'MiniMax-M2.5', region: 'domestic' },
  { id: 'baichuan', label: '百川大模型', protocol: 'openai', endpoint: 'https://api.baichuan-ai.com/v1/chat/completions', model: 'Baichuan4-Turbo', region: 'domestic' },
  { id: 'stepfun', label: '阶跃星辰 StepFun', protocol: 'openai', endpoint: 'https://api.stepfun.com/v1/chat/completions', model: 'step-2-16k', region: 'domestic' },
  { id: 'lingyi', label: '零一万物 (01.AI)', protocol: 'openai', endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions', model: 'yi-large', region: 'domestic' },
  { id: 'tiangong', label: '昆仑万维 天工', protocol: 'openai', endpoint: 'https://api.tiangong.cn/v1/chat/completions', model: 'Skywork-4.0', region: 'domestic' },
  { id: 'sensetime', label: '商汤 SenseChat', protocol: 'openai', endpoint: 'https://api.sensenova.cn/compatible-mode/v1/chat/completions', model: 'SenseChat-5', region: 'domestic' },
  { id: 'mimo', label: '小米 MiMo (按量付费)', protocol: 'openai', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-pro', region: 'domestic' },
  { id: 'mimo-plan', label: '小米 MiMo (Token Plan 订阅)', protocol: 'openai', endpoint: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-pro', region: 'domestic' },
  // ===== Coding / 开发专用 =====
  { id: 'github-copilot', label: 'GitHub Copilot', protocol: 'openai', endpoint: 'https://api.githubcopilot.com/chat/completions', model: 'gpt-4o', region: 'foreign' },
  { id: 'codegeex', label: 'CodeGeeX (智谱)', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'codegeex-4-all-9b', region: 'domestic' },
  { id: 'codestral', label: 'Codestral (Mistral 编程)', protocol: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions', model: 'codestral-latest', region: 'foreign' },
  { id: 'deepseek-coder', label: 'DeepSeek Coder', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-coder', region: 'domestic' },
  { id: 'qwen-coder', label: '通义千问 Coder', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-coder-plus', region: 'domestic' },
  { id: 'codebuddy', label: '腾讯 CodeBuddy', protocol: 'openai', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'codebuddy-code', region: 'domestic' },
  // ===== 聚合平台 =====
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', protocol: 'openai', endpoint: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3', region: 'domestic' },
  { id: 'modelscope', label: '魔搭 ModelScope (阿里)', protocol: 'openai', endpoint: 'https://api-inference.modelscope.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-72B-Instruct', region: 'domestic' },
  { id: 'dmxapi', label: 'DMXAPI 聚合', protocol: 'openai', endpoint: 'https://www.dmxapi.cn/v1/chat/completions', model: 'gpt-4o-mini', region: 'domestic' },
  { id: 'aihubmix', label: 'AiHubMix 聚合', protocol: 'openai', endpoint: 'https://aihubmix.com/v1/chat/completions', model: 'gpt-4.1-free', region: 'foreign' },
  { id: 'oneapi', label: 'OneAPI 聚合', protocol: 'openai', endpoint: 'https://api.oneapi.pro/v1/chat/completions', model: 'gpt-4o-mini', region: 'foreign' },
];

/** 根据端点 URL 自动推断协议 */
function detectProtocol(endpoint: string): 'openai' | 'anthropic' | 'custom' {
  const lower = endpoint.toLowerCase();
  if (lower.includes('anthropic.com') || lower.endsWith('/v1/messages')) return 'anthropic';
  return 'openai'; // 绝大多数供应商兼容 OpenAI 格式
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
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
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
  const [importPreview, setImportPreview] = useState<{
    providers: Array<{ id: string; name: string; protocol: string; apiEndpoint: string; model: string; alternativeModels?: string[] }>;
    conflictIds: string[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [cryptoFeedback, setCryptoFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

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
  const handleApplyPreset = (preset: typeof PRESETS[number]) => {
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

          {/* J1：供应商列表（紧凑单列行风格，参考 PresetSection / AiAppSection） */}
          <div className="provider-list" data-name="settings.provider.list">
          {providers.map((p, idx) => {
            // 根据协议生成主题色（用于图标背景）
            const protoColor = p.protocol === 'anthropic' ? '#d97757' : p.protocol === 'openai' ? '#10a37f' : '#6366f1';
            return (
              <div className="provider-row" key={p.id} data-name={`advanced-panel.provider-card-${idx + 1}`} data-index={idx + 1} data-id={p.id}>
                {/* 左侧：首字母图标 */}
                <span
                  className="provider-row-icon"
                  style={{ background: protoColor }}
                  aria-hidden="true"
                  data-name={`advanced-panel.provider-card-${idx + 1}-icon`}
                >
                  {p.name.charAt(0).toUpperCase()}
                </span>

                {/* 中间：名称 + endpoint */}
                <span className="provider-row-info" data-name={`advanced-panel.provider-card-${idx + 1}-info`}>
                  <span className="provider-row-name-line" data-name={`advanced-panel.provider-card-${idx + 1}-name-line`}>
                    <span className="provider-row-name" data-name={`advanced-panel.provider-card-${idx + 1}-name`}>{p.name}</span>
                    <Badge variant="accent" data-name={`advanced-panel.provider-card-${idx + 1}-protocol-badge`}>{p.protocol}</Badge>
                  </span>
                  <span className="provider-row-endpoint" title={p.apiEndpoint} data-name={`advanced-panel.provider-card-${idx + 1}-endpoint`}>{p.apiEndpoint}</span>
                </span>

                {/* 右侧：导出勾选 + 操作按钮 */}
                <div className="provider-row-actions" data-name={`advanced-panel.provider-card-${idx + 1}-actions`}>
                  {!editing && (
                    <label
                      className="provider-row-export-check"
                      title="勾选后点加密导出，仅导出选中项"
                      data-name={`advanced-panel.provider-card-${idx + 1}-export-check-label`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedExportIds.has(p.id)}
                        onChange={(e) => handleToggleExportSelect(p.id, e.target.checked)}
                        data-name={`advanced-panel.provider-card-${idx + 1}-export-check-input`}
                      />
                    </label>
                  )}
                  <Button type="button" variant="text" className="provider-action-btn compact" onClick={() => handleEdit(p)} data-name={`advanced-panel.provider-card-${idx + 1}-edit-button`}>编辑</Button>
                  <Button type="button" variant="text" danger className="provider-action-btn compact danger" onClick={() => void handleDelete(p.id)} data-name={`advanced-panel.provider-card-${idx + 1}-delete-button`}>删除</Button>
                </div>
              </div>
            );
          })}

          {/* 卡片式新增按钮：追加在列表末尾（与 AI 应用卡片式新增同步） */}
          {!editing && (
            <button
              type="button"
              className="preset-card preset-card-add"
              onClick={handleAdd}
              data-name="advanced-panel.provider-add-button"
            >
              <span className="preset-card-add-icon" aria-hidden="true">+</span>
              <span className="preset-card-add-text">添加供应商</span>
            </button>
          )}
          </div>

          {/* v0.5.2 B-4：加密导出 / 导入工具栏（卡片列表下方） */}
          {!editing && (
            <div className="provider-crypto-panel v2" data-name="advanced-panel.crypto-panel">
              <div className="provider-crypto-toolbar" data-name="advanced-panel.crypto-toolbar">
                <label className="provider-crypto-select-all" data-name="advanced-panel.crypto-select-all">
                  <input
                    type="checkbox"
                    checked={selectedExportIds.size === providers.length && providers.length > 0}
                    onChange={(e) => handleToggleSelectAll(e.target.checked)}
                    disabled={providers.length === 0}
                    data-name="advanced-panel.crypto-select-all-input"
                  />
                  <span>全选</span>
                </label>
                <Button
                  type="button"
                  variant="text"
                  onClick={handleStartExport}
                  disabled={providers.length === 0 && selectedExportIds.size === 0}
                  data-name="advanced-panel.crypto-export-button"
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
                  data-name="advanced-panel.crypto-import-button"
                  className="provider-crypto-action-btn"
                >
                  加密导入
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* 编辑/新建表单（Modal 替代原 .provider-edit-overlay） */}
      {/* portal=true：渲染到 document.body，脱离侧滑面板 transform 的影响，全屏覆盖进阶面板 */}
      <Modal
        open={editing !== null}
        onClose={handleCancel}
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
                onChange={(e) => updateField('name', e.target.value)}
              />
            </FormRow>
            {/* API 端点 + 预设下拉合并为 Combobox：输入框可自定义端点，下拉箭头展开供应商预设 */}
            <FormRow label="API 端点" compact data-name="advanced-panel.provider-form-endpoint-row">
              <Combobox
                inputValue={editing.apiEndpoint}
                onInputChange={(v) => handleEndpointChange(v)}
                inputPlaceholder="https://api.openai.com/v1/chat/completions"
                inputClassName="provider-form-input"
                options={PRESETS.map<ComboboxOption>((p) => ({
                  value: p.id,
                  label: p.label,
                  selected: p.endpoint === editing.apiEndpoint,
                }))}
                onSelect={(v) => {
                  const preset = PRESETS.find(p => p.id === v);
                  if (preset) handleApplyPreset(preset);
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
                  onChange={(e) => updateField('apiKey', e.target.value)}
                />
                <IconButton
                  type="button"
                  className="provider-api-key-toggle"
                  aria-label={showApiKey ? '隐藏密钥' : '显示密钥'}
                  title={showApiKey ? '隐藏密钥' : '显示密钥'}
                  data-name="advanced-panel.provider-form-api-key-toggle"
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
            <FormRow label="模型" compact data-name="advanced-panel.provider-form-model-row">
              <div className="provider-model-section" data-name="advanced-panel.provider-form-model-section">
                {/* 第一行：模型输入 + 搜索按钮 + 统一下拉（右侧无其他组件） */}
                <div className="provider-model-combobox" data-name="advanced-panel.provider-form-model-combobox">
                  <Combobox
                    inputValue={editing.model}
                    onInputChange={(v) => updateField('model', v)}
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
                    onSelect={(v) => handleToggleModel(v, true)}
                    onDeselect={(v) => handleToggleModel(v, false)}
                    multiple
                    searchable
                    searchPlaceholder="搜索模型名…"
                    open={showModelDropdown}
                    onOpenChange={setShowModelDropdown}
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
                    onClick={() => void handleSearchModels()}
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
                          onClick={() => handleRemoveModelChip(m)}
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
                    updateField('temperature', v === '' ? undefined : Number(v));
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
                    updateField('maxTokens', v === '' ? undefined : Number(v));
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
                    onChange={(v) => void handleTtsToggle(v)}
                    name="tts-toggle"
                    options={[
                      { value: 'off', label: '关' },
                      { value: 'on', label: '开' },
                    ]}
                  />
                  {editing.ttsEnabled && (
                    <Combobox
                      inputValue={editing.ttsModel ?? ''}
                      onInputChange={(v) => setEditing({ ...editing, ttsModel: v })}
                      inputPlaceholder="tts-1"
                      inputClassName="provider-form-input provider-voice-model-input"
                      options={modelCandidates.map<ComboboxOption>((m) => ({
                        value: m,
                        label: m,
                        selected: editing.ttsModel === m,
                        tag: isTtsModel(m) ? 'TTS' : undefined,
                      }))}
                      onSelect={(v) => setEditing({ ...editing, ttsModel: v })}
                      searchable
                      searchPlaceholder="搜索模型…"
                      open={showTtsDropdown}
                      onOpenChange={setShowTtsDropdown}
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
                    onChange={(v) => void handleSttToggle(v)}
                    name="stt-toggle"
                    options={[
                      { value: 'off', label: '关' },
                      { value: 'on', label: '开' },
                    ]}
                  />
                  {editing.sttEnabled && (
                    <Combobox
                      inputValue={editing.sttModel ?? ''}
                      onInputChange={(v) => setEditing({ ...editing, sttModel: v })}
                      inputPlaceholder="whisper-1"
                      inputClassName="provider-form-input provider-voice-model-input"
                      options={modelCandidates.map<ComboboxOption>((m) => ({
                        value: m,
                        label: m,
                        selected: editing.sttModel === m,
                        tag: isSttModel(m) ? 'STT' : undefined,
                      }))}
                      onSelect={(v) => setEditing({ ...editing, sttModel: v })}
                      searchable
                      searchPlaceholder="搜索模型…"
                      open={showSttDropdown}
                      onOpenChange={setShowSttDropdown}
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
              <Button type="button" variant="outline" className="provider-form-btn" disabled={testing || saving} onClick={() => void handleTest()} data-name="advanced-panel.provider-form-test-button">
                {testing ? '测试中…' : '测试连通性'}
              </Button>
              <Button type="button" variant="primary-flat" className="provider-form-btn" disabled={testing || saving} onClick={() => void handleSave()} data-name="advanced-panel.provider-form-save-button">
                {saving ? '保存中…' : '保存'}
              </Button>
              <Button type="button" variant="outline" className="provider-form-btn" disabled={testing || saving} onClick={handleCancel} data-name="advanced-panel.provider-form-cancel-button">取消</Button>
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
        data-name="advanced-panel.export-dialog"
      >
        <p className="provider-form-dialog-desc" data-name="advanced-panel.export-dialog-desc">
          {selectedExportIds.size > 0
            ? `导出 ${selectedExportIds.size} 个 Provider 到 .sapp 文件，输入加密密码。`
            : `导出全部 ${providers.length} 个 Provider 到 .sapp 文件，输入加密密码。`}
        </p>
        <FormRow label="加密密码" compact data-name="advanced-panel.export-dialog-password-row">
          <input
            type="password"
            className="provider-form-input"
            placeholder="输入密码"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
            autoFocus
            autoComplete="off"
            data-name="advanced-panel.export-dialog-password-input"
          />
        </FormRow>
        {cryptoFeedback && (
          <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.export-dialog-feedback">
            {cryptoFeedback.msg}
          </div>
        )}
        <div className="provider-form-actions" data-name="advanced-panel.export-dialog-actions">
          <Button
            type="button"
            variant="outline"
            className="provider-form-btn"
            disabled={exporting}
            onClick={() => setExportDialogOpen(false)}
            data-name="advanced-panel.export-dialog-cancel-button"
          >
            取消
          </Button>
          <Button
            type="button"
            variant="primary-flat"
            className="provider-form-btn"
            disabled={!exportPassword.trim() || exporting}
            onClick={() => void handleConfirmExport()}
            data-name="advanced-panel.export-dialog-confirm-button"
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
        data-name="advanced-panel.import-dialog"
      >
        {!importPreview ? (
          <>
            <p className="provider-form-dialog-desc" data-name="advanced-panel.import-dialog-step1-desc">
              选择 .sapp 文件并输入密码。
            </p>
            <FormRow label="文件" compact data-name="advanced-panel.import-dialog-file-row">
              <div className="provider-import-file-row">
                <input
                  type="text"
                  className="provider-form-input"
                  value={importFilePath}
                  readOnly
                  placeholder="选择 .sapp 文件..."
                  data-name="advanced-panel.import-dialog-file-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleSelectImportFile()}
                  data-name="advanced-panel.import-dialog-select-file-button"
                >
                  选择文件
                </Button>
              </div>
            </FormRow>
            <FormRow label="解密密码" compact data-name="advanced-panel.import-dialog-password-row">
              <input
                type="password"
                className="provider-form-input"
                placeholder="输入密码"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                autoComplete="off"
                data-name="advanced-panel.import-dialog-password-input"
              />
            </FormRow>
            {cryptoFeedback && (
              <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.import-dialog-step1-feedback">
                {cryptoFeedback.msg}
              </div>
            )}
            <div className="provider-form-actions" data-name="advanced-panel.import-dialog-step1-actions">
              <Button
                type="button"
                variant="outline"
                className="provider-form-btn"
                disabled={importing}
                onClick={() => setImportDialogOpen(false)}
                data-name="advanced-panel.import-dialog-cancel-button"
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary-flat"
                className="provider-form-btn"
                disabled={!importFilePath || !importPassword.trim() || importing}
                onClick={() => void handlePreviewImport()}
                data-name="advanced-panel.import-dialog-preview-button"
              >
                {importing ? '解析中…' : '预览'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="provider-form-dialog-desc" data-name="advanced-panel.import-dialog-step2-desc">
              导入 {importPreview.providers.length} 个 Provider，其中 {importPreview.conflictIds.length} 个覆盖现有配置。
            </p>
            <div className="provider-import-preview-list" data-name="advanced-panel.import-dialog-preview-list">
              {importPreview.providers.map((p, idx) => {
                const isConflict = importPreview.conflictIds.includes(p.id);
                return (
                  <div
                    key={p.id}
                    className={`provider-import-preview-item ${isConflict ? 'conflict' : 'new'}`}
                    data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}`}
                    data-index={idx + 1}
                    data-id={p.id}
                  >
                    <span className="provider-import-preview-name" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-name`}>{p.name}</span>
                    <span className="provider-import-preview-meta" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-meta`}>{p.protocol} · {p.model}</span>
                    <span className="provider-import-preview-tag" data-name={`advanced-panel.import-dialog-preview-item-${idx + 1}-tag`}>
                      {isConflict ? '覆盖' : '新增'}
                    </span>
                  </div>
                );
              })}
            </div>
            {cryptoFeedback && (
              <div className={`provider-test-result ${cryptoFeedback.type === 'success' ? 'ok' : 'fail'}`} data-name="advanced-panel.import-dialog-step2-feedback">
                {cryptoFeedback.msg}
              </div>
            )}
            <div className="provider-form-actions" data-name="advanced-panel.import-dialog-step2-actions">
              <Button
                type="button"
                variant="outline"
                className="provider-form-btn"
                disabled={importing}
                onClick={() => setImportPreview(null)}
                data-name="advanced-panel.import-dialog-back-button"
              >
                返回
              </Button>
              <Button
                type="button"
                variant="primary-flat"
                className="provider-form-btn"
                disabled={importing}
                onClick={() => void handleConfirmImport()}
                data-name="advanced-panel.import-dialog-confirm-button"
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
