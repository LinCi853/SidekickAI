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
  enumerateInputDevices,
  getVoiceConfig,
  onPreviewUpdate,
  onPreviewHide,
  onPreviewPartial,
  onVoiceRecordStart,
  onVoiceRecordStop,
  sendVoiceRecordData,
  updateInputDeviceList,
} from '../lib/electron-api';
import './RecordIndicator.css';

type RecordStatus = 'recording' | 'transcribing' | 'done' | 'sent';

interface RecordState {
  text: string;
  status: RecordStatus;
  /** 流式识别的部分结果（实时更新） */
  partialText?: string;
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
      setState({ text: payload.text, status: payload.status, partialText: undefined });
    });
    const offHide = onPreviewHide(() => {
      setState((s) => ({ text: s.text, status: 'done', partialText: undefined }));
    });
    const offPartial = onPreviewPartial((payload) => {
      setState((s) => ({ ...s, partialText: payload.text }));
    });
    return () => {
      offUpdate();
      offHide();
      offPartial();
    };
  }, []);

  // ===== 渲染进程音频采集 + 实时音量分析 =====
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
      {/* 药丸主体 */}
      <div className="record-pill" data-name="record-indicator.pill">

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
          {isRecording && !state.partialText && (
            <div className="wave-container" aria-hidden="true" data-name="record-indicator.wave-container">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
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
          {isRecording && state.partialText && (
            <span className="record-text" data-name="record-indicator.partial-text">
              {state.partialText}
            </span>
          )}
          {isTranscribing && (
            <span className="record-text" data-name="record-indicator.transcribing-text">
              {state.partialText || '正在识别…'}
            </span>
          )}
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
    </div>
  );
}
