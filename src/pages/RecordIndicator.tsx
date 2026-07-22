/* =====================================================================
   pages/RecordIndicator.tsx —— 录音指示器（长条形透明胶囊）
   设计：360x56 长条形透明窗口，显示：
   - 左侧：录音状态图标（录音中红点 / 识别中转圈 / 完成打勾 / 错误叉）
   - 中间：实时音量波形（录音中）/ 状态文字 / 识别结果文本
   - 右侧：关闭按钮（hover 显示）
   录音中：用 AnalyserNode 实时分析音量，波形条随声音大小跳动
   识别中：显示"正在识别…"
   完成/错误：显示识别结果或错误信息，3 秒后自动隐藏
   ===================================================================== */

import { useEffect, useRef, useState } from 'react';
import {
  closeCurrentWindow,
  enumerateInputDevices,
  forceStopRecording,
  getVoiceConfig,
  onPreviewUpdate,
  onPreviewHide,
  onVoiceRecordStart,
  onVoiceRecordStop,
  onVoiceBuiltinStart,
  sendVoiceRecordData,
  sendVoiceBuiltinResult,
  sendVoiceBuiltinError,
  updateInputDeviceList,
} from '../lib/electron-api';
import './RecordIndicator.css';

/* =====================================================================
   Web Speech API 类型声明（Chromium 私有 API，不在标准 DOM lib 中）
   webkitSpeechRecognition 仅在渲染进程（浏览器上下文）可用，主进程无法调用。
   ===================================================================== */

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}
interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionConstructor = { new (): ISpeechRecognition };

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type RecordStatus = 'recording' | 'transcribing' | 'done' | 'sent';

interface RecordState {
  text: string;
  status: RecordStatus;
}

/**
 * 录音指示器（长条形透明胶囊窗口）。
 * 负责音频采集 + 实时音量波形 + 状态显示 + 识别结果展示。
 */
export default function RecordIndicator() {
  const [state, setState] = useState<RecordState>({
    text: '',
    status: 'recording',
  });
  /** 实时音量等级 0~1，用于驱动波形条高度 */
  const [volumeLevel, setVolumeLevel] = useState(0);

  useEffect(() => {
    const offUpdate = onPreviewUpdate((payload) => {
      setState({ text: payload.text, status: payload.status });
    });
    const offHide = onPreviewHide(() => {
      setState((s) => ({ text: s.text, status: 'done' }));
    });
    return () => {
      offUpdate();
      offHide();
    };
  }, []);

  // ===== 客户端自愈：录音态超过 60s 自动结束 =====
  useEffect(() => {
    if (state.status !== 'recording') return;
    const CLIENT_RECORDING_TIMEOUT_MS = 60_000;
    const timer = setTimeout(() => {
      console.warn('[RecordIndicator] 客户端录音超时（60s），强制结束并通知主进程');
      setState({ text: '录音超时未结束，请重新尝试', status: 'done' });
      try {
        void forceStopRecording('preview-timeout');
      } catch (e) {
        /* ignore */
      }
    }, CLIENT_RECORDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state.status]);

  // ===== 渲染进程音频采集（替代主进程 ffmpeg）+ 实时音量分析 =====
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  /** 启动实时音量分析循环（录音中持续运行） */
  const startVolumeAnalysis = (stream: MediaStream) => {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);
        // 计算 RMS 音量
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        // 归一化到 0~1，适当放大以便低音量也能看到波形
        const level = Math.min(1, rms * 3);
        setVolumeLevel(level);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[RecordIndicator] 音量分析启动失败:', err);
    }
  };

  /** 停止音量分析循环 */
  const stopVolumeAnalysis = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close();
      } catch (e) {
        /* ignore */
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setVolumeLevel(0);
  };

  // 枚举麦克风设备
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await enumerateInputDevices();
        if (cancelled) return;
        console.log(`[RecordIndicator] enumerateDevices 返回 ${list.length} 个音频输入设备`);
        if (list.length > 0) {
          await updateInputDeviceList(list);
        }
      } catch (err) {
        console.warn('[RecordIndicator] 启动枚举设备失败:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const offStart = onVoiceRecordStart(async () => {
      try {
        chunksRef.current = [];
        let deviceId = '';
        try {
          const cfg = await getVoiceConfig();
          deviceId = cfg?.inputDeviceId || '';
        } catch (e) {
          console.warn('[RecordIndicator] 读取 voice config 失败，使用系统默认麦克风', e);
        }
        const audioConstraints: MediaStreamConstraints['audio'] = {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        };
        if (deviceId) {
          (audioConstraints as Record<string, unknown>).deviceId = { exact: deviceId };
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        mediaStreamRef.current = stream;
        // 启动实时音量分析
        startVolumeAnalysis(stream);
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start();
        mediaRecorderRef.current = recorder;
      } catch (err) {
        console.error('[RecordIndicator] getUserMedia 启动失败:', err);
        sendVoiceRecordData([]);
      }
    });

    const offStop = onVoiceRecordStop(() => {
      // 停止音量分析
      stopVolumeAnalysis();
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        sendVoiceRecordData([]);
        return;
      }
      recorder.onstop = async () => {
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((t) => t.stop());
          mediaStreamRef.current = null;
        }
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          const arrayBuffer = await blob.arrayBuffer();
          const audioContext = new AudioContext({ sampleRate: 16000 });
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          const channelData = audioBuffer.getChannelData(0);
          const pcm = Array.from(channelData);
          sendVoiceRecordData(pcm);
          audioContext.close();
        } catch (err) {
          console.error('[RecordIndicator] 音频解码失败:', err);
          sendVoiceRecordData([]);
        }
        chunksRef.current = [];
        mediaRecorderRef.current = null;
      };
      recorder.stop();
    });

    return () => {
      offStart();
      offStop();
      stopVolumeAnalysis();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
    };
  }, []);

  // ===== builtin 模式：Web Speech API 识别（Chromium 渲染层 API） =====
  // 主进程在 builtin 模式下停止 PCM 录音（释放麦克风）后，通过 voice:builtinStart
  // 通知本组件启动 webkitSpeechRecognition。识别结果通过 voice:builtinResult 回传主进程。
  // 关键：webkitSpeechRecognition 自己管理麦克风访问，与 getUserMedia 互斥，
  //       因此主进程必须先停止 PCM 录音（stopCaptureOnly）释放设备后再发送 start 信号。
  const recognitionRef = useRef<ISpeechRecognition | null>(null);

  useEffect(() => {
    const offBuiltinStart = onVoiceBuiltinStart((payload) => {
      // 选择可用的 SpeechRecognition 构造器（Chromium 用 webkitSpeechRecognition）
      const Ctor = window.webkitSpeechRecognition || window.SpeechRecognition;
      if (!Ctor) {
        console.error('[RecordIndicator] webkitSpeechRecognition 不可用（可能未联网或浏览器不支持）');
        sendVoiceBuiltinError('浏览器不支持 Web Speech API');
        return;
      }

      // 中止上一次未结束的识别实例（避免重叠）
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }

      try {
        const recognition = new Ctor();
        recognition.lang = payload.language || 'zh-CN';
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        let gotResult = false;

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          // 提取最终识别文本（interimResults=false 时 results 中只有 final 结果）
          const result = event.results[event.results.length - 1];
          if (result && result.isFinal) {
            const transcript = result[0]?.transcript || '';
            gotResult = true;
            console.log('[RecordIndicator] Web Speech 识别结果:', transcript);
            sendVoiceBuiltinResult(transcript);
          }
        };

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          const errMsg = event.error || 'unknown';
          console.warn('[RecordIndicator] Web Speech 识别错误:', errMsg, event.message);
          // no-speech（未检测到语音）/ network（网络问题）/ not-allowed（麦克风拒绝）
          // 统一回传错误，主进程展示通用提示
          sendVoiceBuiltinError(`Web Speech 识别失败：${errMsg}`);
        };

        recognition.onend = () => {
          // 识别结束（正常结束或被 abort）。若无结果回传，发空结果触发主进程兜底提示
          if (!gotResult) {
            console.warn('[RecordIndicator] Web Speech 结束但无结果');
            sendVoiceBuiltinResult('');
          }
          recognitionRef.current = null;
        };

        recognitionRef.current = recognition;
        console.log('[RecordIndicator] 启动 webkitSpeechRecognition, lang=' + recognition.lang);
        recognition.start();
      } catch (err) {
        console.error('[RecordIndicator] 启动 webkitSpeechRecognition 失败:', err);
        sendVoiceBuiltinError('启动 Web Speech 失败：' + (err instanceof Error ? err.message : String(err)));
      }
    });

    return () => {
      offBuiltinStart();
      // 组件卸载时中止残留的识别实例
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const handleClose = () => {
    void closeCurrentWindow();
  };

  const isRecording = state.status === 'recording';
  const isTranscribing = state.status === 'transcribing';
  const isDone = state.status === 'done' || state.status === 'sent';
  const isError = isDone && !!(state.text && (
    state.text.includes('失败') ||
    state.text.includes('未识别') ||
    state.text.includes('超时')
  ));

  return (
    <div
      className={`record-indicator status-${state.status}${isError ? ' error-state' : ''}`}
      data-name="record-indicator.container"
    >
      {/* 整窗可拖拽区域 */}
      <div className="record-drag" data-name="record-indicator.drag-region" />

      {/* 关闭按钮：右上角，hover 显示 */}
      <button
        type="button"
        className="record-close"
        onClick={handleClose}
        title="关闭"
        aria-label="关闭"
        data-name="record-indicator.close-button"
      >
        <svg className="icon-svg-sm" viewBox="0 0 10 10" fill="none" data-name="record-indicator.close-icon">
          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      {/* 左侧：状态图标 */}
      <div className="record-icon" data-name="record-indicator.icon-container">
        {isRecording && (
          <div className="icon-recording" data-name="record-indicator.recording-icon">
            <div className="rec-dot" data-name="record-indicator.rec-dot" />
          </div>
        )}
        {isTranscribing && (
          <div className="icon-spinner" aria-label="识别中" data-name="record-indicator.spinner-icon">
            <svg className="icon-svg" viewBox="0 0 16 16" fill="none" data-name="record-indicator.spinner-icon-svg">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
              <path
                d="M14 8a6 6 0 0 0-6-6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from="0 8 8"
                  to="360 8 8"
                  dur="0.8s"
                  repeatCount="indefinite"
                />
              </path>
            </svg>
          </div>
        )}
        {isDone && (
          <div className="icon-done" data-name="record-indicator.done-icon">
            {state.text && !state.text.includes('失败') && !state.text.includes('未识别') && !state.text.includes('超时') ? (
              <svg className="icon-svg" viewBox="0 0 14 14" fill="none" data-name="record-indicator.done-check-icon">
                <path d="M2 7L6 11L12 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg className="icon-svg" viewBox="0 0 14 14" fill="none" data-name="record-indicator.done-error-icon">
                <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* 中间：音量波形 / 状态文字 / 识别结果 */}
      <div className="record-content" data-name="record-indicator.content">
        {isRecording && (
          <div className="wave-container" aria-hidden="true" data-name="record-indicator.wave-container">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
              // 每根条根据音量 + 位置偏移生成高度
              const phase = (i % 3) * 0.15;
              const height = Math.max(3, Math.min(20, volumeLevel * 24 + phase * 8 + 3));
              return (
                <span
                  key={i}
                  className="wave-bar"
                  style={{
                    height: `${height}px`,
                    opacity: 0.4 + volumeLevel * 0.6,
                  }}
                  data-name={`record-indicator.wave-bar-${i + 1}`}
                  data-index={i + 1}
                  data-id={String(i + 1)}
                />
              );
            })}
          </div>
        )}
        {isTranscribing && <span className="record-text" data-name="record-indicator.transcribing-text">正在识别…</span>}
        {isDone && (
          <span
            className="record-text record-text-result"
            title={state.text}
            data-name="record-indicator.result-text"
          >
            {state.text || '已完成'}
          </span>
        )}
      </div>

      {/* 右侧：录音时长/状态标签 */}
      <div className="record-label" data-name="record-indicator.label">
        {isRecording && <span className="label-rec" data-name="record-indicator.label-rec">REC</span>}
      </div>
    </div>
  );
}
