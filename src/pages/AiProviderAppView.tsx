/* =====================================================================
   pages/AiProviderAppView.tsx —— AI 应用独立窗口主视图
   架构：
   - 顶栏：tab 切换（自定义供应商 / 自定义对话）+ 窗口控制（最小化/最大化/关闭）
   - 主体：根据 activeTab 渲染两个子页面
     · providers  —— 自定义供应商管理（添加/编辑/删除/测试，复用 useChatStore 的 provider 管理）
     · chat       —— 自定义对话（复用 useChatStore 的会话/流式；左侧会话列表 + 右侧消息区）
   - 通过 URL 查询参数 ?mode=ai-app-provider[&provider=...&tab=...] 接收初始状态
   - 主进程通过 'ai-app-provider:navigate' 事件通知切换 tab/provider（单例窗口复用时）
   ===================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowResizeHandles from '../components/WindowResizeHandles';
import { useChatStore } from '../store/useChatStore';
import {
  minimizeWindow,
  maximizeToggleWindow,
  closeCurrentWindow,
  isWindowMaximized,
  isWindowAlwaysOnTop,
  onMaximizeToggled,
  onPinToggled,
  onAiAppProviderNavigate,
  pinCurrentWindow,
  listAIProviderModels,
  exportAIProvidersEncrypted,
  importAIProvidersEncrypted,
  // v0.5.2 B-4：文件对话框 + 预览导入 + 文件读写
  selectAIProviderExportPath,
  selectAIProviderImportFile,
  writeAIProviderExportFile,
  readAIProviderImportFile,
  previewImportAIProviders,
} from '../lib/electron-api';
import type {
  CustomAIProvider,
  CustomAIProviderInput,
} from '../lib/electron-api';
import Badge from '../components/ui/Badge';
import { Button, IconButton, SegmentedControl } from '../components/ui';
import { MessageBubble } from './MessageBubble';
import WhiteboardView from './WhiteboardView';
import NotesView from './NotesView';
import './AiProviderAppView.css';

type TabKey = 'chat' | 'whiteboard' | 'notes';

/** 从 URL 查询参数读取初始 tab */
function readInitialTab(): TabKey {
  if (typeof window === 'undefined') return 'chat';
  const t = new URLSearchParams(window.location.search).get('tab');
  if (t === 'whiteboard' || t === 'notes') return t;
  return 'chat';
}

/** 从 URL 查询参数读取初始 providerId */
function readInitialProviderId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('provider');
}

export default function AiProviderAppView() {
  const [activeTab, setActiveTab] = useState<TabKey>(readInitialTab);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [providersModalOpen, setProvidersModalOpen] = useState(false);
  const initialProviderId = useMemo(() => readInitialProviderId(), []);

  // 监听主进程的 navigate 事件（单例窗口复用时切换 tab/provider）
  useEffect(() => {
    return onAiAppProviderNavigate((payload) => {
      setActiveTab(payload.tab);
      if (payload.providerId) {
        useChatStore.getState().setCurrentProvider(payload.providerId);
      }
    });
  }, []);

  // 初始化时若 URL 指定了 provider，切换 chat tab 并选中该 provider
  useEffect(() => {
    if (initialProviderId) {
      setActiveTab('chat');
      useChatStore.getState().setCurrentProvider(initialProviderId);
    }
  }, [initialProviderId]);

  // 读取窗口最大化状态
  useEffect(() => {
    void isWindowMaximized().then(setIsMaximized).catch(() => {});
  }, []);

  // 读取窗口置顶状态 + 监听主进程 F11/F12 拦截器推送的状态变更
  useEffect(() => {
    void isWindowAlwaysOnTop().then(setIsPinned).catch(() => {});
  }, []);
  useEffect(() => {
    const offPin = onPinToggled((onTop) => setIsPinned(onTop));
    const offMax = onMaximizeToggled((max) => setIsMaximized(max));
    return () => { offPin(); offMax(); };
  }, []);

  // ESC：供应商编辑表单打开时关闭表单，否则关闭窗口
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // 检查是否有编辑表单/加密对话框打开（通过 DOM 查询）
      const editorOpen = document.querySelector('.provider-edit-overlay, .provider-form-overlay.is-open');
      if (editorOpen) {
        e.preventDefault();
        (editorOpen as HTMLElement).click();
        return;
      }
      // 检查供应商模态是否打开
      const modalOpen = document.querySelector('.providers-modal-overlay');
      if (modalOpen) {
        e.preventDefault();
        setProvidersModalOpen(false);
        return;
      }
      e.preventDefault();
      void closeCurrentWindow();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleMinimize = useCallback(() => void minimizeWindow().catch(() => {}), []);
  const handleMaximize = useCallback(() => {
    void maximizeToggleWindow()
      .then(setIsMaximized)
      .catch(() => {});
  }, []);
  const handleClose = useCallback(() => void closeCurrentWindow().catch(() => {}), []);

  return (
    <div className="ai-app-provider-view app-shell" data-name="ai-app-provider.container">
      <TitleBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        maximized={isMaximized}
        isPinned={isPinned}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onClose={handleClose}
        onOpenSettings={() => setProvidersModalOpen(true)}
        onTogglePin={async () => {
          const next = !isPinned;
          setIsPinned(next);
          try { await pinCurrentWindow(next); } catch { setIsPinned(!next); }
        }}
      />
      <div className="ai-app-provider-body" data-name="ai-app-provider.body">
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'whiteboard' && <WhiteboardView />}
        {activeTab === 'notes' && <NotesView />}
      </div>
      {providersModalOpen && <ProvidersModal onClose={() => setProvidersModalOpen(false)} />}
      <WindowResizeHandles />
    </div>
  );
}

/* =====================================================================
   顶栏：tab 切换 + 窗口控制按钮
   ===================================================================== */
interface TitleBarProps {
  activeTab: TabKey;
  onTabChange: (t: TabKey) => void;
  maximized: boolean;
  isPinned: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onTogglePin: () => void;
}

function TitleBar({ activeTab, onTabChange, maximized, isPinned, onMinimize, onMaximize, onClose, onOpenSettings, onTogglePin }: TitleBarProps) {
  return (
    <div className="ai-app-top" data-name="ai-app-provider.topbar">
      <div className="ai-app-top-tabs" data-name="ai-app-provider.topbar-tabs">
        <SegmentedControl<TabKey>
          value={activeTab}
          onChange={onTabChange}
          name="ai-app-tab"
          className="ai-app-segmented"
          options={[
            { value: 'chat', label: '自定义对话' },
            { value: 'whiteboard', label: '白板' },
            { value: 'notes', label: '灵感笔记' },
          ]}
        />
      </div>
      <div className="ai-app-top-actions" data-name="ai-app-provider.topbar-actions">
        <IconButton
          type="button"
          className="ai-app-win-btn"
          onClick={onOpenSettings}
          title="设置"
          aria-label="设置"
          data-name="ai-app-provider.topbar-settings-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-settings-icon">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          variant={isPinned ? 'active' : 'default'}
          className="ai-app-win-btn"
          onClick={onTogglePin}
          title={isPinned ? '取消置顶' : '置顶'}
          aria-label={isPinned ? '取消置顶' : '置顶'}
          data-name="ai-app-provider.topbar-pin-button"
        >
          <svg viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-pin-icon">
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          className="ai-app-win-btn"
          onClick={onMinimize}
          title="最小化"
          aria-label="最小化"
          data-name="ai-app-provider.topbar-minimize-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-minimize-icon">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </IconButton>
        <IconButton
          type="button"
          className="ai-app-win-btn"
          onClick={onMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label="最大化"
          data-name="ai-app-provider.topbar-maximize-button"
        >
          {maximized ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-restore-icon">
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-maximize-icon">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          )}
        </IconButton>
        <IconButton
          type="button"
          variant="close"
          className="ai-app-win-btn close"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          data-name="ai-app-provider.topbar-close-button"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }} data-name="ai-app-provider.topbar-close-icon">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
}

/* =====================================================================
   「供应商管理」遮罩模态 —— 添加/编辑/删除/测试/加密导出导入
   ===================================================================== */
function ProvidersModal({ onClose }: { onClose: () => void }) {
  const {
    providers,
    loadingProviders,
    initProviders,
    addProvider,
    editProvider,
    removeProvider,
    testProviderConn,
  } = useChatStore();

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

  // v0.5.2 regress-1：供应商来源预设
  const PRESETS: Array<{ id: string; label: string; protocol: 'openai' | 'anthropic' | 'custom'; endpoint: string; model: string }> = [
    { id: 'openai', label: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    { id: 'qwen', label: '通义千问', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    { id: 'kimi', label: 'Kimi', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    { id: 'zhipu', label: '智谱', protocol: 'openai', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  ];

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
    <>
    <div className="providers-modal-overlay" onClick={onClose} data-name="ai-app-provider.providers-modal-overlay">
      <div className="providers-modal" onClick={(e) => e.stopPropagation()} data-name="ai-app-provider.providers-modal">
        <div className="providers-modal-header" data-name="ai-app-provider.providers-modal-header">
          <h2 className="providers-modal-title">供应商管理</h2>
          <IconButton
            type="button"
            className="providers-modal-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            data-name="ai-app-provider.providers-modal-close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '60%', height: '60%' }}>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </IconButton>
        </div>
        <div className="providers-modal-body" data-name="ai-app-provider.providers-modal-body">
      {loadingProviders && providers.length === 0 && (
        <div className="ai-app-tab-hint" data-name="ai-app-provider.providers-loading">正在加载...</div>
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
        </div>{/* /.providers-modal-body */}

      {/* 编辑/新建表单（二级遮罩） */}
      {editing && (
        <div className="provider-edit-overlay" onClick={handleCancel} data-name="ai-app-provider.provider-edit-overlay">
        <div className="provider-edit-dialog" onClick={(e) => e.stopPropagation()} data-name="ai-app-provider.provider-form">
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-name-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-name-label">名称</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-protocol-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-protocol-label">协议</label>
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
          </div>
          {/* v0.5.2 regress-1：供应商来源预设 Chip */}
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-preset-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-preset-label">供应商来源预设</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-endpoint-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-endpoint-label">API 端点</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-api-key-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-api-key-label">API 密钥</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-model-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-model-label">模型</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-temperature-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-temperature-label">温度（0~2，可选）</label>
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
          </div>
          <div className="provider-form-row" data-name="ai-app-provider.provider-form-max-tokens-row">
            <label className="provider-form-label" data-name="ai-app-provider.provider-form-max-tokens-label">最大 token（可选）</label>
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
          </div>
          <div className="provider-form-row provider-voice-config">
            <label className="provider-form-label">语音配置</label>
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
          </div>
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
        </div>{/* /.provider-edit-dialog */}
        </div>
      )}
      </div>{/* /.providers-modal */}
    </div>
    {exportDialogOpen && (
      <div
        className="provider-form-overlay is-open"
        onClick={() => !exporting && setExportDialogOpen(false)}
        data-name="ai-app-provider.export-dialog-overlay"
      >
        <div
          className="provider-form-dialog"
          onClick={(e) => e.stopPropagation()}
          data-name="ai-app-provider.export-dialog"
        >
          <h3 className="provider-form-dialog-title" data-name="ai-app-provider.export-dialog-title">加密导出</h3>
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
        </div>
      </div>
    )}
    {importDialogOpen && (
      <div
        className="provider-form-overlay is-open"
        onClick={() => !importing && setImportDialogOpen(false)}
        data-name="ai-app-provider.import-dialog-overlay"
      >
        <div
          className="provider-form-dialog"
          onClick={(e) => e.stopPropagation()}
          data-name="ai-app-provider.import-dialog"
        >
          <h3 className="provider-form-dialog-title" data-name="ai-app-provider.import-dialog-title">加密导入</h3>
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
        </div>
      </div>
    )}
    </>
  );
}

/* =====================================================================
   「自定义对话」tab —— 会话列表 + 消息区（复用 useChatStore）
   ===================================================================== */
function ChatTab() {
  const {
    providers,
    currentProviderId,
    conversations,
    currentConversationId,
    messages,
    streaming,
    streamingText,
    streamError,
    initProviders,
    initConversations,
    setCurrentProvider,
    selectConversation,
    startNewConversation,
    removeConversation,
    sendMessage,
    cancelStream,
    registerStreamListeners,
  } = useChatStore();

  const [input, setInput] = useState('');
  // 需求 10：记录文本模板（ChatTab 为全局单例 tab，使用 localStorage 持久化）
  const [showRecordTemplate, setShowRecordTemplate] = useState(false);
  const [recordTextPrefix, setRecordTextPrefix] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('chat-tab-record-prefix') ?? '';
  });
  const [recordTextSuffix, setRecordTextSuffix] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('chat-tab-record-suffix') ?? '';
  });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 需求 10：模板字段变更时持久化到 localStorage
  const persistRecordTemplate = (next: { prefix: string; suffix: string }) => {
    try {
      localStorage.setItem('chat-tab-record-prefix', next.prefix);
      localStorage.setItem('chat-tab-record-suffix', next.suffix);
    } catch (e) {
      console.warn('[ChatTab] 持久化记录文本模板失败:', e);
    }
  };

  // 初始化 providers + 流式监听
  useEffect(() => {
    void initProviders();
    const off = registerStreamListeners();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // provider 加载后初始化会话列表
  useEffect(() => {
    if (currentProviderId) {
      void initConversations().then(() => {
        const state = useChatStore.getState();
        if (state.currentConversationId) return;
        // 恢复上次会话
        const last = localStorage.getItem(`chat-last-conv-${currentProviderId}`);
        if (last && state.conversations.some((c) => c.id === last)) {
          void state.selectConversation(last);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProviderId]);

  // 自动聚焦输入框（组件挂载时，即窗口打开 / 切换到 chat tab 时）
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // 消息列表自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput('');
    // 需求 10：传递记录文本模板（前缀/后缀 + tag=provider 名），主进程保存 assistant 消息前应用
    await sendMessage(trimmed, undefined, {
      recordTextPrefix: recordTextPrefix || undefined,
      recordTextSuffix: recordTextSuffix || undefined,
      tag: currentProvider?.name,
    });
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡触发路由回退（需求 14）
      void handleSend();
    }
  };

  const currentProvider = providers.find((p) => p.id === currentProviderId);

  return (
    <div className="ai-app-chat" data-name="ai-app-provider.chat">
      {/* 左侧：provider 选择 + 会话列表 */}
      <aside className="ai-app-chat-sidebar" data-name="ai-app-provider.chat-sidebar">
        <div className="ai-app-chat-provider" data-name="ai-app-provider.chat-provider">
          <label className="ai-app-chat-provider-label" data-name="ai-app-provider.chat-provider-label">当前模型</label>
          <div className="ai-app-chat-provider-selector" data-name="ai-app-provider.chat-provider-selector">
            <select
              className="ai-app-chat-provider-select"
              value={currentProviderId ?? ''}
              onChange={(e) => setCurrentProvider(e.target.value)}
              disabled={providers.length === 0}
              data-name="ai-app-provider.chat-provider-select"
            >
              {providers.length === 0 && <option value="" data-name="ai-app-provider.chat-provider-select-empty-option">未配置供应商</option>}
              {providers.map((p, idx) => (
                <option key={p.id} value={p.id} data-name={`ai-app-provider.chat-provider-select-option-${idx + 1}`} data-index={idx + 1} data-id={p.id}>{p.name} · {p.model}</option>
              ))}
            </select>
            <svg className="ai-app-chat-provider-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" data-name="ai-app-provider.chat-provider-arrow-icon">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          {currentProvider && (
            <div className="ai-app-chat-provider-meta" data-name="ai-app-provider.chat-provider-meta">{currentProvider.model}</div>
          )}
        </div>
        <Button type="button" variant="ghost" className="ai-app-chat-new" onClick={startNewConversation} data-name="ai-app-provider.chat-new-conversation-button">+ 新建对话</Button>
        <div className="ai-app-chat-conv-list" data-name="ai-app-provider.chat-conv-list">
          {conversations.length === 0 && (
            <div className="ai-app-chat-empty" data-name="ai-app-provider.chat-conv-empty">暂无对话</div>
          )}
          {conversations.map((c, idx) => (
            <div
              key={c.id}
              className={`ai-app-chat-conv-item${c.id === currentConversationId ? ' active' : ''}`}
              data-name={`ai-app-provider.chat-conv-item-${idx + 1}`}
              data-index={idx + 1}
              data-id={c.id}
            >
              <button
                type="button"
                className="ai-app-chat-conv-main"
                onClick={() => void selectConversation(c.id)}
                title={c.title}
                data-name={`ai-app-provider.chat-conv-item-${idx + 1}-main`}
              >
                <span className="ai-app-chat-conv-title" data-name={`ai-app-provider.chat-conv-item-${idx + 1}-title`}>{c.title || '未命名对话'}</span>
              </button>
              <IconButton
                type="button"
                className="ai-app-chat-conv-del"
                onClick={() => void removeConversation(c.id)}
                title="删除对话"
                aria-label="删除对话"
                data-name={`ai-app-provider.chat-conv-item-${idx + 1}-delete-button`}
              >
                ×
              </IconButton>
            </div>
          ))}
        </div>
      </aside>

      {/* 右侧：消息区 + 输入框 */}
      <section className="ai-app-chat-main" data-name="ai-app-provider.chat-main">
        <div className="ai-app-chat-messages" data-name="ai-app-provider.chat-messages">
          {messages.length === 0 && !streaming && (
            <div className="ai-app-chat-placeholder" data-name="ai-app-provider.chat-placeholder">
              {currentProvider ? `开始与 ${currentProvider.name} 对话` : '请先在「自定义供应商」页配置供应商'}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {streaming && streamingText && (
            <MessageBubble
              message={{
                id: 'streaming',
                conversationId: currentConversationId ?? '',
                role: 'assistant',
                content: streamingText,
                createdAt: Date.now(),
              }}
            />
          )}
          {streamError && (
            <div className="ai-app-chat-error" data-name="ai-app-provider.chat-error">{streamError}</div>
          )}
          <div ref={messagesEndRef} data-name="ai-app-provider.chat-messages-end" />
        </div>
        {/* 需求 10：记录文本模板折叠面板 */}
        <div className="ai-app-chat-record-template" data-name="ai-app-provider.chat-record-template-panel">
          <button
            type="button"
            className="ai-app-chat-record-template-toggle"
            data-name="ai-app-provider.chat-record-template-toggle-button"
            onClick={() => setShowRecordTemplate((v) => !v)}
          >
            {showRecordTemplate ? '▾' : '▸'} 记录文本模板
          </button>
          {showRecordTemplate && (
            <div className="ai-app-chat-record-template-body" data-name="ai-app-provider.chat-record-template-body">
              <div className="ai-app-chat-record-template-row" data-name="ai-app-provider.chat-record-template-prefix-row">
                <label className="ai-app-chat-record-template-label" data-name="ai-app-provider.chat-record-template-prefix-label">前缀</label>
                <input
                  type="text"
                  className="ai-app-chat-record-template-input"
                  data-name="ai-app-provider.chat-record-template-prefix-input"
                  placeholder="例如：[{{time}}] "
                  value={recordTextPrefix}
                  onChange={(e) => setRecordTextPrefix(e.target.value)}
                  onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                />
              </div>
              <div className="ai-app-chat-record-template-row" data-name="ai-app-provider.chat-record-template-suffix-row">
                <label className="ai-app-chat-record-template-label" data-name="ai-app-provider.chat-record-template-suffix-label">后缀</label>
                <input
                  type="text"
                  className="ai-app-chat-record-template-input"
                  data-name="ai-app-provider.chat-record-template-suffix-input"
                  placeholder="例如：——{{tag}}"
                  value={recordTextSuffix}
                  onChange={(e) => setRecordTextSuffix(e.target.value)}
                  onBlur={() => persistRecordTemplate({ prefix: recordTextPrefix, suffix: recordTextSuffix })}
                />
              </div>
              <div className="ai-app-chat-record-template-hint" data-name="ai-app-provider.chat-record-template-hint">
                占位符：<code>{'{{time}}'}</code> 当前时间；<code>{'{{tag}}'}</code> 供应商名。仅影响保存的 AI 回复，不改变实时显示。
              </div>
            </div>
          )}
        </div>
        <div className="ai-app-chat-input-wrap" data-name="ai-app-provider.chat-input-wrap">
          <textarea
            ref={inputRef}
            className="ai-app-chat-input"
            value={input}
            placeholder={currentProvider ? `发送给 ${currentProvider.name}...` : '请先选择供应商'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!currentProviderId}
            data-name="ai-app-provider.chat-input-textarea"
          />
          <div className="ai-app-chat-input-actions" data-name="ai-app-provider.chat-input-actions">
            {streaming ? (
              <button type="button" className="btn-primary-flat ai-app-chat-send cancel" onClick={() => void cancelStream()} data-name="ai-app-provider.chat-stop-button">停止</button>
            ) : (
              <button
                type="button"
                className="btn-primary-flat ai-app-chat-send"
                onClick={() => void handleSend()}
                disabled={!input.trim() || !currentProviderId}
                data-name="ai-app-provider.chat-send-button"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
