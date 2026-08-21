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
type ConfirmMode = 'auto' | 'clipboard';

interface VoiceSectionProps {
  voice: VoiceSettings;
  onChange: (patch: Partial<VoiceSettings>) => void;
  /** 标题是否可折叠（在进阶配置内使用时设为 false，避免二次折叠） */
  collapsibleTitle?: boolean;
}

export default function VoiceSection({ voice, onChange, collapsibleTitle = true }: VoiceSectionProps) {
  const {
    confirmMode: voiceConfirmMode,
    inputMethod: voiceInputMethod,
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
  const setVoiceInputMethod = (v: 'layered' | 'clipboard' | 'type') => onChange({ inputMethod: v });
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
        语音
      </SectionTitle>
      {(!collapsibleTitle || !collapsed) && (
        <>
      {/* 语音识别 */}
      <FormRow stack label="识别引擎">
        <SegmentedControl
          className="voice-mode-group"
          name="stt-mode"
          value={voiceSttMode}
          onChange={handleModeChange}
          options={[
            { value: 'ai', label: 'AI 接入' },
            { value: 'local', label: '本地软件' },
          ]}
        />
      </FormRow>

      {/* 麦克风 + 服务商：紧凑单行布局 */}
      <div className="voice-compact-row" data-name="settings.voice.mic-row">
        <FormRow compact label="麦克风">
          <Combobox
            inputValue={
              voiceInputDeviceId === ''
                ? '默认'
                : inputDeviceList.find((d) => d.deviceId === voiceInputDeviceId)?.label
                  ?? `未命名 (${voiceInputDeviceId.slice(0, 8)}…)`
            }
            onInputChange={() => {}}
            inputPlaceholder="选择设备"
            inputReadOnly
            options={[
              { value: '', label: '系统默认麦克风', selected: voiceInputDeviceId === '' },
              ...inputDeviceList.map<ComboboxOption>((d) => ({
                value: d.deviceId,
                label: d.label || `未命名 (${d.deviceId.slice(0, 8)}…)`,
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
            searchPlaceholder="搜索…"
            emptyText="无匹配"
            dataName="settings.voice.mic-select"
          />
          <button
            type="button"
            className="btn-outline voice-btn-secondary btn-secondary-underline"
            onClick={refreshDevices}
            disabled={refreshingDevices}
            data-name="settings.voice.mic-refresh-button"
          >
            {refreshingDevices ? '…' : '刷新'}
          </button>
        </FormRow>
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
            testLabel="测试"
            testingLabel="测试中…"
            testDisabled={(d) => !d.provider}
            renderTestResultExtra={(r) =>
              r.text ? (
                <div className="voice-test-result-text" data-name="settings.voice.ai-test-result-text">
                  回声：{r.text}
                </div>
              ) : null
            }
          >
            {({ draft, setDraft }) => (
              <div className="voice-provider-row">
                <FormRow compact label="服务商">
                  <Combobox
                    inputValue={(() => {
                      const builtin: Record<string, string> = {
                        openai: 'OpenAI (Whisper)',
                        azure: 'Azure',
                        google: 'Google',
                        custom: '自定义',
                      };
                      if (builtin[draft.provider]) return builtin[draft.provider];
                      const p = sttProviders.find((x) => x.id === draft.provider);
                      return p ? p.name : '';
                    })()}
                    onInputChange={() => {}}
                    inputPlaceholder="选择服务商"
                    inputReadOnly
                    options={[
                      { value: 'openai', label: 'OpenAI (Whisper)', selected: draft.provider === 'openai' },
                      { value: 'azure', label: 'Azure Speech', selected: draft.provider === 'azure' },
                      { value: 'google', label: 'Google Cloud', selected: draft.provider === 'google' },
                      { value: 'custom', label: '自定义接口', selected: draft.provider === 'custom' },
                      ...sttProviders.map<ComboboxOption>((p) => ({
                        value: p.id,
                        label: `${p.name}（自定义）`,
                        selected: p.id === draft.provider,
                      })),
                    ]}
                    onSelect={(v) => setDraft({ provider: v })}
                    searchable
                    searchPlaceholder="搜索…"
                    emptyText="无匹配"
                    dataName="settings.voice.ai-provider-select"
                  />
                </FormRow>
                <FormRow compact label="语言">
                  <Combobox
                    inputValue={(() => {
                      const map: Record<string, string> = {
                        zh: '中文',
                        en: '英文',
                        ja: '日文',
                        ko: '韩文',
                        auto: '自动',
                      };
                      return map[voiceLanguage] ?? '';
                    })()}
                    onInputChange={() => {}}
                    inputPlaceholder="选择语言"
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
                    searchPlaceholder="搜索…"
                    emptyText="无匹配"
                    dataName="settings.voice.ai-language-select"
                  />
                </FormRow>
              </div>
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
                <FormRow stack label="可执行文件">
                  <input
                    type="text"
                    className="input-underline"
                    placeholder="whisper.exe 路径"
                    value={draft.exePath}
                    onChange={(e) => setDraft({ ...draft, exePath: e.target.value })}
                    data-name="settings.voice.local-exe-input"
                  />
                </FormRow>
                <FormRow stack label="参数">
                  <input
                    type="text"
                    className="input-underline"
                    placeholder="-m model.bin -l zh"
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

      {/* 语音合成 + 上屏方式：合并为紧凑区域 */}
      <div className="voice-section-divider" data-name="settings.voice.tts-divider" />
      <FormRow compact label="语音合成">
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
            { value: 'ai', label: 'AI 接入' },
          ]}
        />
      </FormRow>
      {voiceTtsMode === 'ai' && (
        <div className="voice-mode-panel" data-name="settings.voice.tts-panel">
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
            testLabel="测试"
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
                    重播
                  </button>
                </div>
              ) : null
            }
          >
            {({ draft, setDraft }) => (
              <FormRow compact label="服务商">
                <Combobox
                  inputValue={(() => {
                    const builtin: Record<string, string> = {
                      openai: 'OpenAI (TTS)',
                      custom: '自定义',
                    };
                    if (builtin[draft.provider]) return builtin[draft.provider];
                    const p = ttsProviders.find((x) => x.id === draft.provider);
                    return p ? p.name : '';
                  })()}
                  onInputChange={() => {}}
                  inputPlaceholder="选择服务商"
                  inputReadOnly
                  options={[
                    { value: 'openai', label: 'OpenAI (TTS)', selected: draft.provider === 'openai' },
                    { value: 'custom', label: '自定义接口', selected: draft.provider === 'custom' },
                    ...ttsProviders.map<ComboboxOption>((p) => ({
                      value: p.id,
                      label: `${p.name}（自定义）`,
                      selected: p.id === draft.provider,
                    })),
                  ]}
                  onSelect={(v) => setDraft({ provider: v })}
                  searchable
                  searchPlaceholder="搜索…"
                  emptyText="无匹配"
                  dataName="settings.voice.tts-provider-select"
                />
              </FormRow>
            )}
          </VoiceProviderConfig>
        </div>
      )}

      {/* 上屏方式 */}
      <FormRow compact label="上屏方式">
        <SegmentedControl
          className="voice-mode-group"
          name="confirm-mode"
          value={voiceConfirmMode}
          onChange={async (mode: 'auto' | 'clipboard') => {
            setVoiceConfirmMode(mode);
            try {
              await setVoiceConfig({ confirmMode: mode });
            } catch (err) {
              console.error('保存 confirmMode 失败:', err);
              setVoiceConfirmMode(voiceConfirmMode);
            }
          }}
          options={[
            { value: 'auto', label: '自动上屏' },
            { value: 'clipboard', label: '仅剪贴板' },
          ]}
        />
      </FormRow>
      {voiceConfirmMode !== 'clipboard' && (
        <>
          <FormRow compact label="第三方输入">
            <SegmentedControl
              className="voice-mode-group"
              name="input-method"
              value={voiceInputMethod}
              onChange={async (method: 'layered' | 'clipboard' | 'type') => {
                setVoiceInputMethod(method);
                try {
                  await setVoiceConfig({ inputMethod: method });
                } catch (err) {
                  console.error('保存 inputMethod 失败:', err);
                  setVoiceInputMethod(voiceInputMethod);
                }
              }}
              options={[
                { value: 'layered', label: '智能' },
                { value: 'clipboard', label: '剪贴板' },
                { value: 'type', label: '键入' },
              ]}
            />
          </FormRow>
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
            自动回车发送
          </label>
        </>
      )}
      </>
      )}
    </section>
  );
}
