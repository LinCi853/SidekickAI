import { useEffect, useState } from 'react';
import type { VoiceSettings } from '../types';
import { SegmentedControl, FormRow, SectionTitle, Combobox } from '../../ui';
import type { ComboboxOption } from '../../ui';
import {
  setVoiceConfig,
  enumerateInputDevices,
  testAiProvider,
  updateInputDeviceList,
  listAIProviders,
  testTtsProvider,
} from '../../../lib/electron-api';
import type { CustomAIProvider } from '../../../lib/electron-api';
import VoiceProviderConfig from './VoiceProviderConfig';

type SttMode = 'ai' | 'local';
type ConfirmMode = 'auto' | 'manual' | 'clipboard';

interface VoiceSectionProps {
  voice: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
  /** 标题是否可折叠（在进阶配置内使用时设为 false，避免二次折叠） */
  collapsibleTitle?: boolean;
}

export default function VoiceSection({ voice, onChange, collapsibleTitle = true }: VoiceSectionProps) {
  const {
    confirmMode: voiceConfirmMode,
    enterToSend: voiceEnterToSend,
    sttMode: voiceSttMode,
    aiProvider: voiceAiProvider,
    language: voiceLanguage,
    localExePath: voiceLocalExePath,
    localArgs: voiceLocalArgs,
    inputDeviceId: voiceInputDeviceId,
    ttsMode: voiceTtsMode,
    ttsProvider: voiceTtsProvider,
  } = voice;

  const setVoiceConfirmMode = (v: ConfirmMode) => onChange({ confirmMode: v });
  const setVoiceEnterToSend = (v: boolean) => onChange({ enterToSend: v });
  const setVoiceSttMode = (v: SttMode) => onChange({ sttMode: v });
  const setVoiceAiProvider = (v: string) => onChange({ aiProvider: v });
  const setVoiceLanguage = (v: string) => onChange({ language: v });
  const setVoiceLocalExePath = (v: string) => onChange({ localExePath: v });
  const setVoiceLocalArgs = (v: string) => onChange({ localArgs: v });
  const setVoiceInputDeviceId = (v: string) => onChange({ inputDeviceId: v });
  const setVoiceTtsMode = (v: 'disable' | 'ai') => onChange({ ttsMode: v });
  const setVoiceTtsProvider = (v: string) => onChange({ ttsProvider: v });
  const [collapsed, setCollapsed] = useState(true);
  const [ttsAudioEl] = useState<HTMLAudioElement | null>(null);

  const handleModeChange = async (mode: SttMode) => {
    setVoiceSttMode(mode);
    try {
      await setVoiceConfig({ sttMode: mode });
    } catch (e) {
      console.error('保存语音引擎模式失败:', e);
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

  useEffect(() => {
    void refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSttMode]);

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

  const sttProviders = customProviders.filter((p) => p.sttEnabled === true);
  const ttsProviders = customProviders.filter((p) => p.ttsEnabled === true);

  return (
    <section data-name="settings.voice.section">
      <SectionTitle
        collapsible={collapsibleTitle}
        collapsed={collapsibleTitle ? collapsed : false}
        onToggle={collapsibleTitle ? () => setCollapsed((v) => !v) : undefined}
      >
        语音输入
      </SectionTitle>
      {(!collapsibleTitle || !collapsed) && (
        <>
      <FormRow stack label="识别引擎">
        <SegmentedControl
          className="voice-mode-group"
          name="stt-mode"
          value={voiceSttMode}
          onChange={handleModeChange}
          options={[
            { value: 'ai', label: '自定义 AI 接入' },
            { value: 'local', label: '本地识别软件' },
          ]}
        />
      </FormRow>

      {/* 麦克风设备选择 */}
      <div className="voice-mode-panel" data-name="settings.voice.mic-panel">
        <FormRow stack label="麦克风设备">
          <Combobox
            inputValue={
              voiceInputDeviceId === ''
                ? '系统默认麦克风'
                : inputDeviceList.find((d) => d.deviceId === voiceInputDeviceId)?.label
                  ?? `未命名设备 (${voiceInputDeviceId.slice(0, 12)}...)`
            }
            onInputChange={() => {}}
            inputPlaceholder="选择麦克风设备"
            inputReadOnly
            options={[
              { value: '', label: '系统默认麦克风', selected: voiceInputDeviceId === '' },
              ...inputDeviceList.map<ComboboxOption>((d) => ({
                value: d.deviceId,
                label: d.label || `未命名设备 (${d.deviceId.slice(0, 12)}...)`,
                selected: d.deviceId === voiceInputDeviceId,
              })),
            ]}
            onSelect={async (v) => {
              setVoiceInputDeviceId(v);
              try {
                await setVoiceConfig({ inputDeviceId: v });
              } catch (err) {
                console.error('保存麦克风设备失败:', err);
              }
            }}
            searchable
            searchPlaceholder="搜索设备…"
            emptyText="无匹配设备"
            dataName="settings.voice.mic-select"
          />
          <button
            type="button"
            className="btn-outline voice-btn-secondary btn-secondary-underline"
            onClick={refreshDevices}
            disabled={refreshingDevices}
            data-name="settings.voice.mic-refresh-button"
          >
            {refreshingDevices ? '刷新中…' : '刷新'}
          </button>
        </FormRow>
        <div className="voice-field-hint" data-name="settings.voice.mic-hint">
          {inputDeviceList.length === 0
            ? '未找到麦克风设备，请确认权限后点击刷新'
            : `共检测到 ${inputDeviceList.length} 个麦克风`}
        </div>
      </div>

      {/* 自定义 AI 接入 */}
      {voiceSttMode === 'ai' && (
        <div className="voice-mode-panel" data-name="settings.voice.ai-panel">
          <VoiceProviderConfig
            scope="ai"
            initial={{ provider: voiceAiProvider }}
            onSave={async (d) => {
              try {
                await setVoiceConfig({ aiProvider: d.provider });
                setVoiceAiProvider(d.provider);
              } catch (e) {
                console.error('保存 AI 接入配置失败:', e);
              }
            }}
            onTest={(d) => testAiProvider({ providerId: d.provider })}
            testLabel="测试连接"
            testingLabel="测试中…"
            testDisabled={(d) => !d.provider}
            renderTestResultExtra={(r) =>
              r.text ? (
                <div className="voice-test-result-text" data-name="settings.voice.ai-test-result-text">
                  识别回声：{r.text}
                </div>
              ) : null
            }
          >
            {({ draft, setDraft }) => (
              <>
                <FormRow stack label="服务商">
                  <Combobox
                    inputValue={(() => {
                      const builtin: Record<string, string> = {
                        openai: 'OpenAI (Whisper API)',
                        azure: 'Azure Speech',
                        google: 'Google Cloud Speech',
                        custom: '自定义兼容接口',
                      };
                      if (builtin[draft.provider]) return builtin[draft.provider];
                      const p = sttProviders.find((x) => x.id === draft.provider);
                      return p ? `${p.name}（自定义）` : '';
                    })()}
                    onInputChange={() => {}}
                    inputPlaceholder="选择服务商"
        
                    inputReadOnly
                    options={[
                      { value: 'openai', label: 'OpenAI (Whisper API)', selected: draft.provider === 'openai' },
                      { value: 'azure', label: 'Azure Speech', selected: draft.provider === 'azure' },
                      { value: 'google', label: 'Google Cloud Speech', selected: draft.provider === 'google' },
                      { value: 'custom', label: '自定义兼容接口', selected: draft.provider === 'custom' },
                      ...sttProviders.map<ComboboxOption>((p) => ({
                        value: p.id,
                        label: `${p.name}（自定义）`,
                        selected: p.id === draft.provider,
                      })),
                    ]}
                    onSelect={(v) => setDraft({ provider: v })}
                    searchable
                    searchPlaceholder="搜索服务商…"
                    emptyText="无匹配项"
                    dataName="settings.voice.ai-provider-select"
                  />
                </FormRow>
                <FormRow stack label="识别语言">
                  <Combobox
                    inputValue={(() => {
                      const map: Record<string, string> = {
                        zh: '中文（普通话）',
                        en: '英文',
                        ja: '日文',
                        ko: '韩文',
                        auto: '自动判断',
                      };
                      return map[voiceLanguage] ?? '';
                    })()}
                    onInputChange={() => {}}
                    inputPlaceholder="选择识别语言"
        
                    inputReadOnly
                    options={[
                      { value: 'zh', label: '中文（普通话）', selected: voiceLanguage === 'zh' },
                      { value: 'en', label: '英文', selected: voiceLanguage === 'en' },
                      { value: 'ja', label: '日文', selected: voiceLanguage === 'ja' },
                      { value: 'ko', label: '韩文', selected: voiceLanguage === 'ko' },
                      { value: 'auto', label: '自动判断', selected: voiceLanguage === 'auto' },
                    ]}
                    onSelect={async (v) => {
                      setVoiceLanguage(v);
                      try {
                        await setVoiceConfig({ language: v });
                      } catch (err) {
                        console.error('保存识别语言失败:', err);
                      }
                    }}
                    searchable
                    searchPlaceholder="搜索语言…"
                    emptyText="无匹配项"
                    dataName="settings.voice.ai-language-select"
                  />
                </FormRow>
              </>
            )}
          </VoiceProviderConfig>
        </div>
      )}

      {/* 本地识别软件 */}
      {voiceSttMode === 'local' && (
        <div className="voice-mode-panel" data-name="settings.voice.local-panel">
          <VoiceProviderConfig
            scope="local"
            initial={{ exePath: voiceLocalExePath, args: voiceLocalArgs }}
            onSave={async (d) => {
              try {
                await setVoiceConfig({
                  localExePath: d.exePath,
                  localArgs: d.args,
                });
                setVoiceLocalExePath(d.exePath);
                setVoiceLocalArgs(d.args);
              } catch (e) {
                console.error('保存本地识别配置失败:', e);
              }
            }}
          >
            {({ draft, setDraft }) => (
              <>
                <FormRow stack label="可执行文件路径">
                  <input
                    type="text"
                    className="input-underline"
                    placeholder="C:\whisper\whisper.exe 或 /usr/local/bin/whisper"
                    value={draft.exePath}
                    onChange={(e) => setDraft({ ...draft, exePath: e.target.value })}
                    data-name="settings.voice.local-exe-input"
                  />
                </FormRow>
                <FormRow stack label="启动参数">
                  <input
                    type="text"
                    className="input-underline"
                    placeholder="-m model.bin -l zh --output-txt"
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                    data-name="settings.voice.local-args-input"
                  />
                </FormRow>
              </>
            )}
          </VoiceProviderConfig>
        </div>
      )}

      {/* TTS（语音合成）独立 section */}
      <SectionTitle className="section-title-spacer">语音合成</SectionTitle>
      <div className="voice-mode-panel" data-name="settings.voice.tts-panel">
        <FormRow stack label="合成模式">
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
        </FormRow>
        {voiceTtsMode === 'ai' && (
          <VoiceProviderConfig
            scope="tts"
            initial={{ provider: voiceTtsProvider }}
            onSave={async (d) => {
              try {
                await setVoiceConfig({ ttsProvider: d.provider });
                setVoiceTtsProvider(d.provider);
              } catch (e) {
                console.error('保存 TTS 配置失败:', e);
              }
            }}
            onTest={(d) => testTtsProvider({ providerId: d.provider })}
            testLabel="测试合成"
            testingLabel="合成中…"
            testDisabled={(d) => !d.provider}
            renderTestResultExtra={(r) =>
              r.ok && r.audioDataUrl ? (
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
              ) : null
            }
          >
            {({ draft, setDraft }) => (
              <FormRow stack label="服务商">
                <Combobox
                  inputValue={(() => {
                    const builtin: Record<string, string> = {
                      openai: 'OpenAI (TTS API)',
                      custom: '自定义兼容接口',
                    };
                    if (builtin[draft.provider]) return builtin[draft.provider];
                    const p = ttsProviders.find((x) => x.id === draft.provider);
                    return p ? `${p.name}（自定义）` : '';
                  })()}
                  onInputChange={() => {}}
                  inputPlaceholder="选择服务商"
      
                  inputReadOnly
                  options={[
                    { value: 'openai', label: 'OpenAI (TTS API)', selected: draft.provider === 'openai' },
                    { value: 'custom', label: '自定义兼容接口', selected: draft.provider === 'custom' },
                    ...ttsProviders.map<ComboboxOption>((p) => ({
                      value: p.id,
                      label: `${p.name}（自定义）`,
                      selected: p.id === draft.provider,
                    })),
                  ]}
                  onSelect={(v) => setDraft({ provider: v })}
                  searchable
                  searchPlaceholder="搜索服务商…"
                  emptyText="无匹配项"
                  dataName="settings.voice.tts-provider-select"
                />
              </FormRow>
            )}
          </VoiceProviderConfig>
        )}
      </div>

      {/* 上屏方式 */}
      <FormRow stack label="识别后上屏方式">
        <Combobox
          inputValue={(() => {
            const mode = voiceConfirmMode === 'manual' ? 'auto' : voiceConfirmMode;
            return mode === 'auto' ? '自动上屏（前台注入 / 后台粘贴）' : '仅复制到剪贴板（手动粘贴）';
          })()}
          onInputChange={() => {}}
          inputPlaceholder="选择上屏方式"
          inputReadOnly
          options={[
            { value: 'auto', label: '自动上屏（前台注入 / 后台粘贴）', selected: (voiceConfirmMode === 'manual' ? 'auto' : voiceConfirmMode) === 'auto' },
            { value: 'clipboard', label: '仅复制到剪贴板（手动粘贴）', selected: voiceConfirmMode === 'clipboard' },
          ]}
          onSelect={async (v) => {
            const next = v as ConfirmMode;
            setVoiceConfirmMode(next);
            try {
              await setVoiceConfig({ confirmMode: next });
            } catch (err) {
              console.error('保存 confirmMode 失败:', err);
              setVoiceConfirmMode(voiceConfirmMode);
            }
          }}
          searchable={false}
          dataName="settings.voice.confirm-mode-select"
        />
      </FormRow>
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
      </>
      )}
    </section>
  );
}
