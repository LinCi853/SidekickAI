import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Button, SegmentedControl } from '../../ui';
import {
  setVoiceConfig,
  listDownloadedModels,
  downloadVoiceModel,
  downloadWhisperCli,
  uninstallWhisperCli,
  uninstallVoiceModel,
  enumerateInputDevices,
  onVoiceDownloadProgress,
  testAiProvider,
  updateInputDeviceList,
  listAIProviders,
  testTtsProvider,
} from '../../../lib/electron-api';
import type { CustomAIProvider, TestTtsResult } from '../../../lib/electron-api';

type SttMode = 'builtin' | 'ai' | 'local' | 'download';
type ConfirmMode = 'auto' | 'manual' | 'clipboard';

interface VoiceSectionProps {
  voiceConfirmMode: ConfirmMode;
  setVoiceConfirmMode: Dispatch<SetStateAction<ConfirmMode>>;
  voiceEnterToSend: boolean;
  setVoiceEnterToSend: Dispatch<SetStateAction<boolean>>;
  voiceSttMode: SttMode;
  setVoiceSttMode: Dispatch<SetStateAction<SttMode>>;
  voiceAiProvider: string;
  setVoiceAiProvider: Dispatch<SetStateAction<string>>;
  voiceLanguage: string;
  setVoiceLanguage: Dispatch<SetStateAction<string>>;
  voiceLocalExePath: string;
  setVoiceLocalExePath: Dispatch<SetStateAction<string>>;
  voiceLocalArgs: string;
  setVoiceLocalArgs: Dispatch<SetStateAction<string>>;
  voiceDownloadModel: string;
  setVoiceDownloadModel: Dispatch<SetStateAction<string>>;
  downloadedModels: string[];
  setDownloadedModels: Dispatch<SetStateAction<string[]>>;
  voiceDownloadStatus: string;
  setVoiceDownloadStatus: Dispatch<SetStateAction<string>>;
  voiceInputDeviceId: string;
  setVoiceInputDeviceId: Dispatch<SetStateAction<string>>;
  /**
   * whisper-cli 引擎二进制是否已下载（**持久化字段**，来自 cfg.cliDownloaded）。
   * 主进程 getVoiceConfig() 在启动时主动扫描磁盘并修正此字段后返回，
   * 渲染层 mount 时 useState 初值直接基于此 prop，**无需** mount 后再异步 checkCliExists。
   * 这是修复"每次打开设置页都看到下载按钮 / 重启后仍提示下载"的关键。
   */
  voiceCliDownloaded: boolean;
  // ===== v0.5.2 B-3：TTS（语音合成）独立配置 =====
  voiceTtsMode: 'disable' | 'ai';
  setVoiceTtsMode: Dispatch<SetStateAction<'disable' | 'ai'>>;
  voiceTtsProvider: string;
  setVoiceTtsProvider: Dispatch<SetStateAction<string>>;
}

const DOWNLOAD_MODELS: Array<{ id: 'whisper-tiny' | 'whisper-base' | 'whisper-small'; label: string; desc: string }> = [
  { id: 'whisper-tiny', label: 'Whisper Tiny', desc: '约 75MB · 速度快' },
  { id: 'whisper-base', label: 'Whisper Base', desc: '约 142MB · 均衡' },
  { id: 'whisper-small', label: 'Whisper Small', desc: '约 466MB · 准确率高' },
];

export default function VoiceSection({
  voiceConfirmMode,
  setVoiceConfirmMode,
  voiceEnterToSend,
  setVoiceEnterToSend,
  voiceSttMode,
  setVoiceSttMode,
  voiceAiProvider,
  setVoiceAiProvider,
  voiceLanguage,
  setVoiceLanguage,
  voiceLocalExePath,
  setVoiceLocalExePath,
  voiceLocalArgs,
  setVoiceLocalArgs,
  voiceDownloadModel,
  setVoiceDownloadModel,
  downloadedModels,
  setDownloadedModels,
  voiceDownloadStatus,
  setVoiceDownloadStatus,
  voiceInputDeviceId,
  setVoiceInputDeviceId,
  voiceCliDownloaded,
  voiceTtsMode,
  setVoiceTtsMode,
  voiceTtsProvider,
  setVoiceTtsProvider,
}: VoiceSectionProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [aiDraft, setAiDraft] = useState<{ provider: string }>({ provider: voiceAiProvider });
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<
    { ok: boolean; message: string; text?: string } | null
  >(null);
  const aiDirty = aiDraft.provider !== voiceAiProvider;

  const [localDraft, setLocalDraft] = useState({
    exePath: voiceLocalExePath,
    args: voiceLocalArgs,
  });
  const [isLocalSaving, setIsLocalSaving] = useState(false);
  const localDirty =
    localDraft.exePath !== voiceLocalExePath || localDraft.args !== voiceLocalArgs;

  // ===== v0.5.2 B-3：TTS draft（完全复制 aiDraft 的模式） =====
  const [ttsDraft, setTtsDraft] = useState<{ provider: string }>({ provider: voiceTtsProvider });
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsTestResult, setTtsTestResult] = useState<TestTtsResult | null>(null);
  const [ttsAudioEl, setTtsAudioEl] = useState<HTMLAudioElement | null>(null);
  const ttsDirty = ttsDraft.provider !== voiceTtsProvider;

  /**
   * 父组件（SettingsPanel）的状态由 useEffect 异步从 getVoiceConfig 加载，
   * 子组件 mount 时 props 多数情况还是空字符串。如果不在 props 变化时同步 draft，
   * 就会卡死在「空表单」上。这是历史上反复出现的"假状态"之一。
   *
   * 同步策略：
   * - 当 draft 与 props 完全一致（说明 user 未编辑），收到 props 变化时立即同步
   * - 当 draft 与 props 不一致（说明 user 正在编辑），不动 draft（避免打断输入）
   * - 保存成功后显式 setVoiceAiXxx() 同步父状态，aiDirty 也会自然归零
   */
  useEffect(() => {
    setAiDraft((prev) => {
      // 用户已编辑（dirty）则不同步，避免打断
      if (prev.provider !== voiceAiProvider) {
        return prev
      }
      return { provider: voiceAiProvider }
    })
  }, [voiceAiProvider])

  useEffect(() => {
    setLocalDraft((prev) => {
      if (prev.exePath !== voiceLocalExePath || prev.args !== voiceLocalArgs) {
        return prev
      }
      return { exePath: voiceLocalExePath, args: voiceLocalArgs }
    })
  }, [voiceLocalExePath, voiceLocalArgs])

  useEffect(() => {
    setTtsDraft((prev) => {
      if (prev.provider !== voiceTtsProvider) {
        return prev
      }
      return { provider: voiceTtsProvider }
    })
  }, [voiceTtsProvider])

  const [downloadPercent, setDownloadPercent] = useState(0);
  const [cliDownloadPercent, setCliDownloadPercent] = useState(0);
  /**
   * CLI 引擎状态。
   * 关键修复：初值直接来自 prop `voiceCliDownloaded`（主进程持久化字段，启动时扫描磁盘修正）。
   * 同步反映真实磁盘状态，**完全无需** mount 后的异步 checkCliExists。
   * 这样：
   *   - 已下载 → 初值 'ready' → 立即显示"已就绪"
   *   - 未下载 → 初值 'idle' → 立即显示"下载"按钮
   *   - 重启后 cfg.cliDownloaded 仍为 true → 仍然 'ready'，**与"下载后离线使用"语义一致**
   */
  const [cliDownloadStatus, setCliDownloadStatus] = useState<
    'idle' | 'downloading' | 'ready' | 'failed'
  >(voiceCliDownloaded ? 'ready' : 'idle');
  /**
   * 关键修复：当 voiceCliDownloaded prop 变化时（父组件 useEffect 异步加载 cfg 完成），
   * 必须同步更新 cliDownloadStatus。
   * 原因：useState 初值只在组件 mount 时读取一次；prop 异步从 false 变 true 后，
   * useState 不会重新初始化，导致 UI 永远停留在 mount 时的 'idle'，
   * 表现为"明明已下载，重启后仍显示下载按钮"。
   * 仅在非 downloading 时同步，避免打断用户主动触发的下载流程。
   */
  useEffect(() => {
    setCliDownloadStatus((prev) => {
      // 正在下载中：保留状态，不打断
      if (prev === 'downloading') return prev
      // cfg 加载完成后，按 prop 重新计算
      return voiceCliDownloaded ? 'ready' : 'idle'
    })
  }, [voiceCliDownloaded])
  /** CLI 下载失败时的明细（HTTP 状态码 / 错误信息），用于 UI 展示 */
  const [cliDownloadError, setCliDownloadError] = useState<string>('');

  useEffect(() => {
    return onVoiceDownloadProgress((p) => {
      if (p.type === 'model') {
        setDownloadPercent(p.percent);
      } else {
        setCliDownloadPercent(p.percent);
        // 状态字符串使用精确匹配（主进程 sendDownloadProgress 传出的固定值）
        if (p.status === '完成') {
          setCliDownloadStatus('ready');
          setCliDownloadError('');
        } else if (p.status === '下载失败') {
          setCliDownloadStatus('failed');
          setCliDownloadError(p.detail ?? '');
        } else if (p.status === '下载中' || p.status === '解压中') {
          setCliDownloadStatus('downloading');
        }
        // 其他状态（如 '下载已在进行中…'）保持现状
      }
    });
  }, []);

  const handleModeChange = async (mode: SttMode) => {
    setVoiceSttMode(mode);
    try {
      await setVoiceConfig({ sttMode: mode });
    } catch (e) {
      console.error('保存语音引擎模式失败:', e);
    }
  };

  const handleSaveAi = async () => {
    setAiSaving(true);
    try {
      await setVoiceConfig({
        aiProvider: aiDraft.provider,
      });
      setVoiceAiProvider(aiDraft.provider);
    } catch (e) {
      console.error('保存 AI 接入配置失败:', e);
    } finally {
      setAiSaving(false);
    }
  };

  const handleSaveTts = async () => {
    setTtsSaving(true);
    try {
      await setVoiceConfig({
        ttsProvider: ttsDraft.provider,
      });
      setVoiceTtsProvider(ttsDraft.provider);
    } catch (e) {
      console.error('保存 TTS 配置失败:', e);
    } finally {
      setTtsSaving(false);
    }
  };

  const handleTestTts = async () => {
    setTtsTestResult(null);
    // 如果有上一次播放的音频，停止
    if (ttsAudioEl) {
      ttsAudioEl.pause();
      setTtsAudioEl(null);
    }
    try {
      const result = await testTtsProvider({ providerId: ttsDraft.provider });
      setTtsTestResult(result);
      if (result.ok && result.audioDataUrl) {
        const audio = new Audio(result.audioDataUrl);
        setTtsAudioEl(audio);
        void audio.play().catch((err) => console.warn('[VoiceSection] TTS 自动播放失败:', err));
      }
    } catch (e) {
      setTtsTestResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleSaveLocal = async () => {
    setIsLocalSaving(true);
    try {
      await setVoiceConfig({
        localExePath: localDraft.exePath,
        localArgs: localDraft.args,
      });
      setVoiceLocalExePath(localDraft.exePath);
      setVoiceLocalArgs(localDraft.args);
    } catch (e) {
      console.error('保存本地识别配置失败:', e);
    } finally {
      setIsLocalSaving(false);
    }
  };

  const handleSelectModel = async (modelId: string) => {
    setVoiceDownloadModel(modelId);
    // 修复：不要把已下载模型的状态强行重置为 'idle'。
    // 直接查 downloadedModels 数组：若新选中的 modelId 在数组里 → 状态 'ready'，
    // 否则 → 'idle'。这样切换到已下载模型时不会再误显"下载"按钮。
    const isDownloaded = downloadedModels.includes(modelId);
    const nextStatus = isDownloaded ? 'ready' : 'idle';
    setVoiceDownloadStatus(nextStatus);
    try {
      // 关键修复：不要写 cfg.downloadStatus —— CLI 检查器也会写这个字段，
      // 会与模型侧互相覆盖导致 UI 错乱。
      // 模型是否已下载的"真值"在 cfg.downloadedModels 数组里（listDownloadedModels
      // mount 时已修正），本组件用 useState 维护当前选中模型的状态即可。
      await setVoiceConfig({ downloadModel: modelId });
    } catch (e) {
      console.error('保存下载模型选择失败:', e);
    }
  };

  const handleDownload = async () => {
    if (!voiceDownloadModel) return;
    setVoiceDownloadStatus('downloading');
    setDownloadPercent(0);
    try {
      await downloadVoiceModel(voiceDownloadModel);
      // 关键：下载成功后把 modelId 加进 downloadedModels 列表
      // 这样后续在模型之间切换时，已下载的模型不会显示"下载"按钮
      const updated = Array.from(new Set([...downloadedModels, voiceDownloadModel]));
      setDownloadedModels(updated);
      try {
        // 只持久化 downloadedModels 列表，不写 downloadStatus（避免与 CLI 字段冲突）
        await setVoiceConfig({ downloadedModels: updated });
      } catch (e) {
        console.error('保存 downloadedModels 失败:', e);
      }
      setVoiceDownloadStatus('ready');
      setDownloadPercent(100);
    } catch (e) {
      setVoiceDownloadStatus('failed');
      console.error('下载模型失败:', e);
    }
  };

  const handleDownloadCli = async () => {
    // 关键修复：不要在这里预先 set 'ready'，由进度事件精确控制最终状态。
    // 之前的问题是 IPC handler 内部 catch 了所有异常后 sendDownloadProgress('下载失败：xxx')，
    // 但 UI 严格匹配 '下载失败' 失败（被前缀 '：' 干扰），导致停留在 'downloading'，
    // 然后 handleDownloadCli 同步把状态改成 'ready' → 永久误判为已就绪。
    setCliDownloadStatus('downloading');
    setCliDownloadPercent(0);
    setCliDownloadError('');
    try {
      await downloadWhisperCli();
      // 不在此设置 'ready'，让 onVoiceDownloadProgress 回调根据精确 status 决定
    } catch (e) {
      setCliDownloadStatus('failed');
      setCliDownloadError(e instanceof Error ? e.message : String(e));
      console.error('下载 whisper-cli 引擎失败:', e);
    }
  };

  /**
   * 卸载 whisper-cli 引擎二进制。
   * 二次确认 → 调 IPC → 成功后立即更新本地状态。
   * 关键：卸载后 voiceCliDownloaded=false，cliDownloadStatus 同步切到 'idle'，
   * 避免"已删了文件但 UI 还显示已就绪"的死锁。
   */
  const [uninstallingCli, setUninstallingCli] = useState(false);
  const handleUninstallCli = async () => {
    if (uninstallingCli) return;
    const ok = window.confirm(
      '确认卸载 whisper-cli 引擎？\n\n将删除 userData/bin/ 下的引擎可执行文件和配套 dll，' +
      '约 30MB。下次使用前需要重新下载。\n\n' +
      '下载的模型文件不会被删除。',
    );
    if (!ok) return;
    setUninstallingCli(true);
    try {
      const result = await uninstallWhisperCli();
      if (result.ok) {
        // 主进程已修正 cfg.cliDownloaded=false，UI 同步切到 'idle' 显示下载按钮
        setCliDownloadStatus('idle');
        setCliDownloadError('');
        setCliDownloadPercent(0);
        console.log(`[VoiceSection] whisper-cli 卸载完成，删除 ${result.removed.length} 项`);
        if (result.reason) {
          console.warn('[VoiceSection] 卸载部分提示:', result.reason);
        }
      } else {
        console.error('[VoiceSection] 卸载 whisper-cli 失败:', result.reason);
        window.alert('卸载失败：' + (result.reason || '未知错误'));
      }
    } catch (e) {
      console.error('[VoiceSection] 卸载 whisper-cli 异常:', e);
      window.alert('卸载失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setUninstallingCli(false);
    }
  };

  /**
   * 卸载指定 whisper 模型文件。
   * 二次确认 → 调 IPC → 成功后从本地 downloadedModels 移除。
   * 关键：卸载后如果当前选中的就是要卸载的，自动切换到第一个仍存在的模型（或清空）。
   */
  const [uninstallingModelId, setUninstallingModelId] = useState<string | null>(null);
  const handleUninstallModel = async (
    modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small',
  ) => {
    if (uninstallingModelId) return;
    const label = DOWNLOAD_MODELS.find((m) => m.id === modelId)?.label || modelId;
    const ok = window.confirm(
      `确认卸载 ${label}？\n\n将删除对应的模型文件，释放磁盘空间。下次使用前需要重新下载。`,
    );
    if (!ok) return;
    setUninstallingModelId(modelId);
    try {
      const result = await uninstallVoiceModel(modelId);
      if (result.ok) {
        // 主动从本地数组移除
        const updated = downloadedModels.filter((id) => id !== modelId);
        setDownloadedModels(updated);
        try {
          await setVoiceConfig({ downloadedModels: updated });
        } catch (e) {
          console.error('[VoiceSection] 持久化 downloadedModels 失败:', e);
        }
        // 关键修复：主进程可能已经切换了 cfg.downloadModel（当要卸载的就是当前选中模型时），
        // 这里把父组件的 voiceDownloadModel 同步过来，确保 UI 与 cfg 一致。
        // 重新拉取最新 cfg 获取切换后的 downloadModel
        try {
          const latest = await setVoiceConfig({}); // 空 patch，setConfig 内部读取并返回当前 cfg
          if (latest && typeof latest.downloadModel === 'string') {
            setVoiceDownloadModel(latest.downloadModel);
            if (latest.downloadModel === '' || !updated.includes(latest.downloadModel)) {
              setVoiceDownloadStatus('idle');
            } else {
              setVoiceDownloadStatus('ready');
            }
          }
        } catch (e) {
          console.error('[VoiceSection] 同步 downloadModel 失败:', e);
        }
        console.log(`[VoiceSection] ${label} 卸载完成:`, result.path);
      } else {
        console.error('[VoiceSection] 卸载模型失败:', result.reason);
        window.alert('卸载失败：' + (result.reason || '未知错误'));
      }
    } catch (e) {
      console.error('[VoiceSection] 卸载模型异常:', e);
      window.alert('卸载失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setUninstallingModelId(null);
    }
  };

  const [inputDeviceList, setInputDeviceList] = useState<Array<{ deviceId: string; label: string; groupId: string }>>([]);
  const [refreshingDevices, setRefreshingDevices] = useState(false);

  const refreshDevices = async () => {
    setRefreshingDevices(true);
    try {
      const list = await enumerateInputDevices();
      setInputDeviceList(list);
      await updateInputDeviceList(list);
      console.log(`[VoiceSection] 已刷新麦克风设备列表，共 ${list.length} 个`);
    } catch (err) {
      console.error('[VoiceSection] 刷新设备列表失败:', err);
    } finally {
      setRefreshingDevices(false);
    }
  };

  // 首次挂载 + 切换到非 builtin 模式时刷新一次（builtin 不需要选麦克风）
  useEffect(() => {
    if (voiceSttMode !== 'builtin') {
      void refreshDevices();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSttMode]);

  // 关键修复：CLI 状态完全由主进程在 getVoiceConfig 时主动扫描磁盘并通过
  // voiceCliExists prop 传入。本组件 mount 时 useState 初值直接基于此 prop
  // （见上面 useState 初值），**无需** 在此再异步 checkCliExists。
  // 之前这里挂 useEffect 异步调用 checkCliExists() 是用户报告"每次打开都看到
  // 下载按钮"的根因——async 调用返回前的渲染帧会显示"下载"按钮。
  // 取消这段代码：避免竞态、消除误显。

  // 关键修复：组件挂载时主动扫描磁盘上所有已下载的 whisper 模型
  // 解决"之前下载过 / 切换到其他模型再切回 / 手动放入模型文件后 cfg 未同步"导致的
  // "已下载却仍提示下载"问题。该调用会主动修正 cfg.downloadedModels（以磁盘为标准）。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await listDownloadedModels()
        if (cancelled) return
        if (result.ok && Array.isArray(result.models)) {
          // 主进程已自动修正 cfg，这里仅同步本地 state
          setDownloadedModels(result.models)
          // 如果当前选中的模型实际已下载，更新状态避免显示"下载"按钮
          if (voiceDownloadModel && result.models.includes(voiceDownloadModel)) {
            if (voiceDownloadStatus !== 'downloading') {
              setVoiceDownloadStatus('ready')
            }
          }
          console.log(`[VoiceSection] 已同步磁盘上 ${result.models.length} 个模型:`, result.models)
        }
      } catch (err) {
        console.warn('[VoiceSection] listDownloadedModels 失败:', err)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // v0.5.2 B-3：mount 时加载自定义 AI Provider 列表（用于 STT/TTS 服务商下拉）
  const [customProviders, setCustomProviders] = useState<CustomAIProvider[]>([]);
  useEffect(() => {
    try {
      listAIProviders()
        .then(setCustomProviders)
        .catch((err) => console.error('[VoiceSection] 加载自定义 AI Provider 列表失败:', err));
    } catch (err) {
      console.error('[VoiceSection] listAIProviders 调用异常:', err);
    }
  }, []);

  // v0.5.2 R-5：按能力位筛选 STT/TTS 可用服务商
  const sttProviders = customProviders.filter((p) => p.sttEnabled === true);
  const ttsProviders = customProviders.filter((p) => p.ttsEnabled === true);

  return (
    <section data-name="settings.voice.section">
      <div
        className="settings-section-title-row collapsible"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCollapsed((v) => !v);
          }
        }}
        data-name="settings.voice.title-row"
      >
        <span className="settings-section-title" data-name="settings.voice.title">语音输入</span>
        <span className={`collapse-toggle-icon${!collapsed ? ' expanded' : ''}`} data-name="settings.voice.collapse-icon">▼</span>
      </div>
      {!collapsed && (
        <>
      <div className="voice-config-name voice-section-subtitle" data-name="settings.voice.engine-subtitle">
        识别引擎
      </div>
      <SegmentedControl
        className="voice-mode-group"
        name="stt-mode"
        value={voiceSttMode}
        onChange={handleModeChange}
        options={[
          { value: 'builtin', label: '内置识别' },
          { value: 'ai', label: '自定义 AI 接入' },
          { value: 'local', label: '本地识别软件' },
          { value: 'download', label: '轻量级下载' },
        ]}
      />

      {/* 麦克风设备选择（所有非 builtin 模式都需要） */}
      {voiceSttMode !== 'builtin' && (
        <div className="voice-mode-panel" data-name="settings.voice.mic-panel">
          <div className="voice-config-row stack" data-name="settings.voice.mic-row">
            <div className="voice-field" data-name="settings.voice.mic-field">
              <label className="voice-field-label" data-name="settings.voice.mic-label">麦克风设备</label>
              <div className="voice-field-row" data-name="settings.voice.mic-input-row">
                <select
                  className="voice-select"
                  value={voiceInputDeviceId}
                  onChange={async (e) => {
                    const next = e.target.value;
                    setVoiceInputDeviceId(next);
                    try {
                      await setVoiceConfig({ inputDeviceId: next });
                    } catch (err) {
                      console.error('保存麦克风设备失败:', err);
                    }
                  }}
                  data-name="settings.voice.mic-select"
                >
                  <option value="" data-name="settings.voice.mic-option-1">系统默认麦克风</option>
                  {inputDeviceList.map((d, idx) => (
                    <option key={d.deviceId} value={d.deviceId} data-name={`settings.voice.mic-option-${idx + 2}`}>
                      {d.label || `未命名设备 (${d.deviceId.slice(0, 12)}...)`}
                    </option>
                  ))}
                </select>
                <Button
                  variant="text"
                  className="voice-btn-secondary"
                  onClick={refreshDevices}
                  disabled={refreshingDevices}
                  data-name="settings.voice.mic-refresh-button"
                >
                  {refreshingDevices ? '刷新中…' : '刷新'}
                </Button>
              </div>
              <div className="voice-field-hint" data-name="settings.voice.mic-hint">
                {inputDeviceList.length === 0
                  ? '未找到麦克风设备，请确认已授权麦克风权限后点击刷新'
                  : `共检测到 ${inputDeviceList.length} 个麦克风；选错设备会导致录音静默或识别失败`}
              </div>
            </div>
          </div>
        </div>
      )}

      {voiceSttMode === 'builtin' && (
        <div className="voice-mode-panel" data-name="settings.voice.builtin-panel">
        </div>
      )}

      {/* 自定义 AI 接入 */}
      {voiceSttMode === 'ai' && (
        <div className="voice-mode-panel" data-name="settings.voice.ai-panel">
          <div className="voice-config-row stack" data-name="settings.voice.ai-config-row">
            <div className="voice-field" data-name="settings.voice.ai-provider-field">
              <label className="voice-field-label" data-name="settings.voice.ai-provider-label">服务商</label>
              <select
                className="voice-select"
                value={aiDraft.provider}
                onChange={(e) => setAiDraft({ provider: e.target.value })}
                data-name="settings.voice.ai-provider-select"
              >
                <option value="openai" data-name="settings.voice.ai-provider-option-1">OpenAI (Whisper API)</option>
                <option value="azure" data-name="settings.voice.ai-provider-option-2">Azure Speech</option>
                <option value="google" data-name="settings.voice.ai-provider-option-3">Google Cloud Speech</option>
                <option value="custom" data-name="settings.voice.ai-provider-option-4">自定义兼容接口</option>
                {sttProviders.map((p, idx) => (
                  <option key={p.id} value={p.id} data-name={`settings.voice.ai-provider-option-custom-${idx + 1}`}>
                    {p.name}（自定义）
                  </option>
                ))}
              </select>
            </div>
            <div className="voice-field" data-name="settings.voice.ai-language-field">
              <label className="voice-field-label" data-name="settings.voice.ai-language-label">识别语言</label>
              <select
                className="voice-select"
                value={voiceLanguage}
                onChange={async (e) => {
                  const next = e.target.value
                  setVoiceLanguage(next)
                  try {
                    await setVoiceConfig({ language: next })
                  } catch (err) {
                    console.error('保存识别语言失败:', err)
                  }
                }}
                data-name="settings.voice.ai-language-select"
              >
                <option value="zh" data-name="settings.voice.ai-language-option-1">中文（普通话）</option>
                <option value="en" data-name="settings.voice.ai-language-option-2">英文</option>
                <option value="ja" data-name="settings.voice.ai-language-option-3">日文</option>
                <option value="ko" data-name="settings.voice.ai-language-option-4">韩文</option>
                <option value="auto" data-name="settings.voice.ai-language-option-5">自动判断</option>
              </select>
            </div>
            {aiDirty && (
              <Button
                variant="primary-compact"
                className="voice-save-btn"
                disabled={aiSaving}
                onClick={handleSaveAi}
                data-name="settings.voice.ai-save-button"
              >
                {aiSaving ? '保存中…' : '保存'}
              </Button>
            )}
            {/* 测试连接：发送静音样本验证 AI 接入是否可正常请求与解析 */}
            <Button
              variant="text"
              className="voice-test-btn"
              disabled={!aiDraft.provider || aiTesting}
              onClick={() => {
                setAiTesting(true);
                setAiTestResult(null);
                testAiProvider({ providerId: aiDraft.provider })
                  .then((res) => setAiTestResult(res))
                  .catch((e) => setAiTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }))
                  .finally(() => setAiTesting(false));
              }}
              data-name="settings.voice.ai-test-button"
            >
              {aiTesting ? '测试中…' : '测试连接'}
            </Button>
            {aiTestResult && (
              <div
                className={`voice-test-result ${aiTestResult.ok ? 'ok' : 'fail'}`}
                data-name="settings.voice.ai-test-result"
              >
                {aiTestResult.message}
                {aiTestResult.text && (
                  <div className="voice-test-result-text" data-name="settings.voice.ai-test-result-text">
                    识别回声：{aiTestResult.text}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {voiceSttMode === 'local' && (
        <div className="voice-mode-panel" data-name="settings.voice.local-panel">
          <div className="voice-config-row stack" data-name="settings.voice.local-config-row">
            <div className="voice-field" data-name="settings.voice.local-exe-field">
              <label className="voice-field-label" data-name="settings.voice.local-exe-label">可执行文件路径</label>
              <input
                type="text"
                className="voice-input"
                placeholder="C:\whisper\whisper.exe 或 /usr/local/bin/whisper"
                value={localDraft.exePath}
                onChange={(e) => setLocalDraft({ ...localDraft, exePath: e.target.value })}
                data-name="settings.voice.local-exe-input"
              />
            </div>
            <div className="voice-field" data-name="settings.voice.local-args-field">
              <label className="voice-field-label" data-name="settings.voice.local-args-label">启动参数</label>
              <input
                type="text"
                className="voice-input"
                placeholder="-m model.bin -l zh --output-txt"
                value={localDraft.args}
                onChange={(e) => setLocalDraft({ ...localDraft, args: e.target.value })}
                data-name="settings.voice.local-args-input"
              />
            </div>
            {localDirty && (
              <Button
                variant="primary-compact"
                className="voice-save-btn"
                disabled={isLocalSaving}
                onClick={handleSaveLocal}
                data-name="settings.voice.local-save-button"
              >
                {isLocalSaving ? '保存中…' : '保存'}
              </Button>
            )}
          </div>
        </div>
      )}

      {voiceSttMode === 'download' && (
        <div className="voice-mode-panel" data-name="settings.voice.download-panel">
          <div className="voice-config-row stack" data-name="settings.voice.download-config-row">
            {DOWNLOAD_MODELS.map((m, idx) => {
              // 关键修复：用 downloadedModels 数组判断是否已下载
              // 不要再依赖 voiceDownloadStatus（它会在切换模型时被覆盖）
              const isModelDownloaded = downloadedModels.includes(m.id);
              const isCurrent = voiceDownloadModel === m.id;
              return (
              <div
                key={m.id}
                className={`voice-model-card ${isCurrent ? 'selected' : ''}`}
                data-name={`settings.voice.download-model-item-${idx + 1}`}
                data-index={idx + 1}
                data-id={m.id}
              >
                <label className="voice-model-info" data-name={`settings.voice.download-model-item-${idx + 1}-info`}>
                  <input
                    type="radio"
                    className="voice-model-radio"
                    name="download-model"
                    checked={isCurrent}
                    onChange={() => handleSelectModel(m.id)}
                    data-name={`settings.voice.download-model-item-${idx + 1}-radio`}
                  />
                  <span className="voice-model-name" data-name={`settings.voice.download-model-item-${idx + 1}-name`}>{m.label}</span>
                  <span className="voice-model-desc" data-name={`settings.voice.download-model-item-${idx + 1}-desc`}>{m.desc}</span>
                </label>
                {isCurrent && (
                  <div className="voice-model-status" data-name={`settings.voice.download-model-item-${idx + 1}-status`}>
                    {isModelDownloaded && voiceDownloadStatus !== 'downloading' && (
                      <>
                        <span className="voice-status-text ready" data-name={`settings.voice.download-model-item-${idx + 1}-status-ready`}>已就绪</span>
                        <Button
                          variant="danger"
                          className="voice-uninstall-btn"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void handleUninstallModel(m.id)
                          }}
                          disabled={uninstallingModelId === m.id}
                          title="删除此模型文件并释放磁盘空间"
                          data-name={`settings.voice.download-model-item-${idx + 1}-uninstall-button`}
                        >
                          {uninstallingModelId === m.id ? '卸载中…' : '卸载'}
                        </Button>
                      </>
                    )}
                    {!isModelDownloaded && voiceDownloadStatus === 'idle' && (
                      <Button
                        variant="primary-compact"
                        className="voice-download-btn"
                        onClick={handleDownload}
                        data-name={`settings.voice.download-model-item-${idx + 1}-download-button`}
                      >
                        下载
                      </Button>
                    )}
                    {voiceDownloadStatus === 'downloading' && (
                      <span className="voice-status-text downloading" data-name={`settings.voice.download-model-item-${idx + 1}-status-downloading`}>下载中… {downloadPercent}%</span>
                    )}
                    {voiceDownloadStatus === 'failed' && (
                      <Button
                        variant="danger"
                        className="voice-download-btn fail"
                        onClick={handleDownload}
                        data-name={`settings.voice.download-model-item-${idx + 1}-retry-button`}
                      >
                        下载失败，点击重试
                      </Button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
            {/* 已下载但未选中的模型：仍提供卸载入口（右上角小字） */}
            {downloadedModels.some((id) => id !== voiceDownloadModel) && (
              <div className="voice-field-hint mt-1" data-name="settings.voice.downloaded-models-hint">
                其他已下载模型：{downloadedModels
                  .filter((id) => id !== voiceDownloadModel)
                  .map((id, idx) => {
                    const m = DOWNLOAD_MODELS.find((x) => x.id === id)
                    const label = m?.label || id
                    return (
                      <span
                        key={id}
                        className="voice-downloaded-model"
                        data-name={`settings.voice.downloaded-model-item-${idx + 1}`}
                        data-index={idx + 1}
                        data-id={id}
                      >
                        {label}
                        <Button
                          variant="link"
                          danger
                          className="voice-uninstall-link-btn"
                          onClick={() => void handleUninstallModel(id as 'whisper-tiny' | 'whisper-base' | 'whisper-small')}
                          disabled={uninstallingModelId === id}
                          data-name={`settings.voice.downloaded-model-item-${idx + 1}-uninstall-button`}
                        >
                          {uninstallingModelId === id ? '卸载中…' : '卸载'}
                        </Button>
                      </span>
                    )
                  })}
              </div>
            )}
            {voiceDownloadStatus === 'downloading' && (
              <div className="voice-progress-track" data-name="settings.voice.download-progress-track">
                <div
                  className="voice-progress-fill"
                  style={{ width: `${downloadPercent}%` }}
                  data-name="settings.voice.download-progress-fill"
                />
              </div>
            )}
            <div className="voice-config-row stack compact mt-2" data-name="settings.voice.cli-block">
              {/* 关键修复：CLI 已就绪时不再显示"运行下载模型所必需"提示，
                  避免与"已就绪"标签形成"已就绪/仍提示需要下载"的认知冲突。
                  useState 初值直接来自 cfg.cliExists（主进程 getVoiceConfig 主动扫描），
                  无中间态，打开设置页瞬间就是真实状态。 */}
              {cliDownloadStatus === 'idle' && (
                <Button
                  variant="primary-compact"
                  className="voice-download-btn"
                  onClick={handleDownloadCli}
                  data-name="settings.voice.cli-download-button"
                >
                  下载 whisper-cli 引擎
                </Button>
              )}
              {cliDownloadStatus === 'downloading' && (
                <div data-name="settings.voice.cli-downloading">
                  <span className="voice-status-text downloading" data-name="settings.voice.cli-downloading-status">下载中… {cliDownloadPercent}%</span>
                  <div className="voice-progress-track mt-1" data-name="settings.voice.cli-downloading-track">
                    <div
                      className="voice-progress-fill"
                      style={{ width: `${cliDownloadPercent}%` }}
                      data-name="settings.voice.cli-downloading-fill"
                    />
                  </div>
                </div>
              )}
              {cliDownloadStatus === 'ready' && (
                <div className="voice-status-row" data-name="settings.voice.cli-ready">
                  <span className="voice-status-text ready" data-name="settings.voice.cli-ready-status">引擎已就绪</span>
                  <Button
                    variant="danger"
                    className="voice-uninstall-btn"
                    onClick={() => void handleUninstallCli()}
                    disabled={uninstallingCli}
                    title="删除 whisper-cli 引擎二进制，释放约 30MB 空间；下次使用需重新下载"
                    data-name="settings.voice.cli-uninstall-button"
                  >
                    {uninstallingCli ? '卸载中…' : '卸载'}
                  </Button>
                </div>
              )}
              {cliDownloadStatus === 'failed' && (
                <div data-name="settings.voice.cli-failed">
                  <Button
                    variant="danger"
                    className="voice-download-btn fail"
                    onClick={handleDownloadCli}
                    data-name="settings.voice.cli-retry-button"
                  >
                    下载失败，点击重试
                  </Button>
                  {cliDownloadError && (
                    <div className="voice-field-hint error" data-name="settings.voice.cli-error">
                      错误：{cliDownloadError}
                    </div>
                  )}
                  <div className="voice-field-hint cli-tip" data-name="settings.voice.cli-tip">
                    提示：whisper-cli 国内下载常被墙，建议改用「自定义 AI 接入」模式（默认 Mimo API）
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* v0.5.2 B-3：TTS（语音合成）独立 section */}
      <div className="voice-config-name voice-section-subtitle" data-name="settings.voice.tts-subtitle">
        语音合成（TTS）
      </div>
      <div className="voice-mode-panel" data-name="settings.voice.tts-panel">
        <div className="voice-config-row stack" data-name="settings.voice.tts-config-row">
          <div className="voice-field" data-name="settings.voice.tts-mode-field">
            <label className="voice-field-label" data-name="settings.voice.tts-mode-label">合成模式</label>
            <SegmentedControl
              className="voice-mode-group"
              name="tts-mode"
              value={voiceTtsMode}
              onChange={async (mode: 'disable' | 'ai') => {
                setVoiceTtsMode(mode);
                try {
                  await setVoiceConfig({ ttsMode: mode });
                } catch (e) {
                  console.error('保存 TTS 模式失败:', e);
                }
              }}
              options={[
                { value: 'disable', label: '关闭' },
                { value: 'ai', label: '自定义 AI 接入' },
              ]}
            />
          </div>
          {voiceTtsMode === 'ai' && (
            <>
              <div className="voice-field" data-name="settings.voice.tts-provider-field">
                <label className="voice-field-label" data-name="settings.voice.tts-provider-label">服务商</label>
                <select
                  className="voice-select"
                  value={ttsDraft.provider}
                  onChange={(e) => setTtsDraft({ provider: e.target.value })}
                  data-name="settings.voice.tts-provider-select"
                >
                  <option value="openai" data-name="settings.voice.tts-provider-option-1">OpenAI (TTS API)</option>
                  <option value="custom" data-name="settings.voice.tts-provider-option-2">自定义兼容接口</option>
                  {ttsProviders.map((p, idx) => (
                    <option key={p.id} value={p.id} data-name={`settings.voice.tts-provider-option-custom-${idx + 1}`}>
                      {p.name}（自定义）
                    </option>
                  ))}
                </select>
              </div>
              {ttsDirty && (
                <Button
                  variant="primary-compact"
                  className="voice-save-btn"
                  disabled={ttsSaving}
                  onClick={handleSaveTts}
                  data-name="settings.voice.tts-save-button"
                >
                  {ttsSaving ? '保存中…' : '保存'}
                </Button>
              )}
              <Button
                variant="text"
                className="voice-test-btn"
                disabled={!ttsDraft.provider || ttsTesting}
                onClick={() => {
                  setTtsTesting(true);
                  setTtsTestResult(null);
                  testTtsProvider({ providerId: ttsDraft.provider })
                    .then((res) => setTtsTestResult(res))
                    .catch((e) => setTtsTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) }))
                    .finally(() => setTtsTesting(false));
                }}
                data-name="settings.voice.tts-test-button"
              >
                {ttsTesting ? '合成中…' : '测试合成'}
              </Button>
              {ttsTestResult && (
                <div
                  className={`voice-test-result ${ttsTestResult.ok ? 'ok' : 'fail'}`}
                  data-name="settings.voice.tts-test-result"
                >
                  {ttsTestResult.message}
                  {ttsTestResult.ok && ttsTestResult.audioDataUrl && (
                    <div className="voice-test-result-text" data-name="settings.voice.tts-test-result-audio">
                      <button
                        type="button"
                        className="btn-primary-flat voice-test-replay-btn"
                        onClick={() => {
                          if (ttsAudioEl) {
                            ttsAudioEl.currentTime = 0;
                            void ttsAudioEl.play().catch(() => {});
                          }
                        }}
                        data-name="settings.voice.tts-test-replay-button"
                      >
                        重新播放
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 上屏方式：候选窗已移除，全部自动上屏以减少操作步骤 */}
      <div className="voice-config-row stack spaced" data-name="settings.voice.confirm-mode-row">
        <div className="voice-config-label static" data-name="settings.voice.confirm-mode-label">
          <span className="voice-config-name" data-name="settings.voice.confirm-mode-name">识别后上屏方式</span>
        </div>
        <select
          className="voice-select"
          value={voiceConfirmMode === 'manual' ? 'auto' : voiceConfirmMode}
          onChange={async (e) => {
            const next = e.target.value as ConfirmMode;
            setVoiceConfirmMode(next);
            try {
              await setVoiceConfig({ confirmMode: next });
            } catch (err) {
              console.error('保存 confirmMode 失败:', err);
              setVoiceConfirmMode(voiceConfirmMode);
            }
          }}
          data-name="settings.voice.confirm-mode-select"
        >
          <option value="auto" data-name="settings.voice.confirm-mode-option-1">自动上屏（前台注入 / 后台粘贴）</option>
          <option value="clipboard" data-name="settings.voice.confirm-mode-option-2">仅复制到剪贴板（手动粘贴）</option>
        </select>
        {voiceConfirmMode !== 'clipboard' && (
          <label className="voice-field-hint voice-enter-send-label" data-name="settings.voice.enter-send-label">
            <input
              type="checkbox"
              checked={voiceEnterToSend}
              onChange={async (e) => {
                const next = e.target.checked;
                setVoiceEnterToSend(next);
                try {
                  await setVoiceConfig({ enterToSend: next });
                } catch (err) {
                  console.error('保存 enterToSend 失败:', err);
                  setVoiceEnterToSend(!next);
                }
              }}
              data-name="settings.voice.enter-send-input"
            />
            前台注入后自动回车发送
          </label>
        )}
      </div>
      </>
      )}
    </section>
  );
}
