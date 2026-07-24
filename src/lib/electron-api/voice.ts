/* =====================================================================
   lib/electron-api/voice.ts —— 语音识别(STT) / 语音热键 / 后台语音 / 语音输入配置
   ===================================================================== */

import type { VoiceConfig } from '../../../electron/shared/types';
import { requireElectron } from './core';

/* =====================================================================
   语音识别 —— 对应 window.electron.stt
   ===================================================================== */

/**
 * 测试当前 AI 接入配置连通性（用于设置页"测试连接"按钮）。
 * 发送 0.3s 静音样本，验证能正常请求并解析。
 * 返回 { ok, message, text? } 便于在 UI 中显示结果
 */
export interface TestAiProviderResult {
  ok: boolean;
  message: string;
  text?: string;
}
export function testAiProvider(input: { providerId: string }): Promise<TestAiProviderResult> {
  const api = requireElectron();
  return api.stt.testAi(input);
}

/**
 * v0.5.2 regress-2：测试 TTS 配置连通性。
 * 向 OpenAI 兼容 /audio/speech 端点发送短文本合成请求，
 * 成功则返回 base64 编码的 audio/mpeg dataURL，渲染层可播放预览。
 */
export interface TestTtsResult {
  ok: boolean;
  message: string;
  audioDataUrl?: string;
}
export function testTtsProvider(input: { providerId: string }): Promise<TestTtsResult> {
  const api = requireElectron();
  return api.voice.testTts(input);
}

/**
 * 强制停止当前录音（preview 客户端兜底用）。
 * 当主进程 keyup 丢失导致 UI 卡在"正在聆听"时，
 * RecordIndicator 客户端会调用此接口触发 stopBackgroundVoice。
 */
export function forceStopRecording(reason: string): Promise<{ ok: boolean; reason?: string }> {
  const api = requireElectron();
  return api.stt.forceStop(reason);
}

/**
 * 麦克风设备信息（来自 navigator.mediaDevices.enumerateDevices）
 */
export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
  groupId: string;
}

/**
 * 调用 navigator.mediaDevices.enumerateDevices 枚举所有音频输入设备。
 * 返回仅 kind='audioinput' 的设备列表。
 *
 * 注意：浏览器出于安全考虑，**未授权麦克风权限前** enumerateDevices 返回的 label 为空字符串。
 * 授权后（首次 getUserMedia 调用成功）才能拿到 label。
 * 本函数会先尝试一次"试探性" getUserMedia 触发权限弹窗，再 enumerateDevices 拿 label，
 * 然后立即关闭试探流（不录制任何音频）。
 */
export async function enumerateInputDevices(): Promise<AudioDeviceInfo[]> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.enumerateDevices !== 'function'
  ) {
    return [];
  }
  try {
    // 试探一次 getUserMedia 触发权限弹窗，拿到 label 后立即关闭
    try {
      const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      probeStream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      // 用户拒绝 / 无麦克风 / 设备占用等情况下，label 仍可能为空
      console.warn('[voice] enumerateInputDevices 试探 getUserMedia 失败（可能未授权）:', err);
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        groupId: d.groupId,
      }));
  } catch (err) {
    console.error('[voice] enumerateDevices 失败:', err);
    return [];
  }
}

/**
 * 上报麦克风设备列表到主进程（保存到 voice-config.inputDeviceList）
 */
export function updateInputDeviceList(list: AudioDeviceInfo[]): Promise<{ ok: boolean; count?: number; reason?: string }> {
  const api = requireElectron();
  return api.stt.updateInputDeviceList(list);
}

/**
 * 扫描 userData/models/ 目录，列出所有已下载的 whisper 模型 id 列表。
 * 关键用途：设置页 mount 时调用一次，把磁盘上真实存在的模型同步进 downloadedModels。
 * 该调用会主动修正 cfg.downloadedModels（以磁盘为最终标准）。
 */
export interface ListDownloadedModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}
export function listDownloadedModels(): Promise<ListDownloadedModelsResult> {
  const api = requireElectron();
  return api.stt.listDownloadedModels();
}

/**
 * 卸载 whisper-cli 引擎二进制：删除 userData/bin/ 下的可执行文件 + 配套 dll + 残留 zip + 修正 cfg。
 * 返回 { ok, removed, reason? }，removed 是已删除的文件名列表。
 * 不删除整个 bin 目录（避免误删用户后续手动放入的工具）。
 */
export interface UninstallCliResult {
  ok: boolean;
  removed: string[];
  reason?: string;
}
export function uninstallWhisperCli(): Promise<UninstallCliResult> {
  const api = requireElectron();
  return api.voice.uninstallWhisperCli();
}

/**
 * 卸载指定 whisper 模型文件：删除对应 ggml-*.bin + 从 cfg.downloadedModels 移除。
 * 返回 { ok, path?, reason? }。
 */
export interface UninstallModelResult {
  ok: boolean;
  path?: string;
  reason?: string;
}
export function uninstallVoiceModel(
  modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small',
): Promise<UninstallModelResult> {
  const api = requireElectron();
  return api.voice.uninstallModel(modelId);
}

/* =====================================================================
   语音热键 + 后台语音 + 预览窗 —— 对应 window.electron.onVoiceInjectAndSend
   ===================================================================== */

/** 后台语音注入载荷（主进程→最近聚焦窗口渲染） */
export interface VoiceInjectPayload {
  text: string;
  /** 是否自动回车发送（仅前台注入场景生效） */
  enterToSend: boolean;
}

/**
 * 监听后台语音识别文本到达事件（主进程→最近聚焦窗口渲染：注入 AI 输入框）。
 * 载荷 { text, enterToSend }：
 *   - enterToSend 控制是否自动回车发送
 *   - 选择器由渲染层从 Profile（aiInputSelector/aiSendSelector）+ 平台预设读取
 * @returns 取消监听函数
 */
export function onVoiceInjectAndSend(
  callback: (payload: VoiceInjectPayload) => void,
): () => void {
  const api = requireElectron();
  return api.onVoiceInjectAndSend(callback);
}

/* =====================================================================
   语音输入配置 —— 对应 window.electron.voice
   ===================================================================== */

/** 读取语音配置（enterToSend 等全局设置） */
export function getVoiceConfig(): Promise<VoiceConfig> {
  const api = requireElectron();
  return api.voice.getConfig();
}

/** 更新语音配置（合并 patch） */
export function setVoiceConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
  const api = requireElectron();
  return api.voice.setConfig(patch);
}

/**
 * 触发后台语音录音（底栏语音按钮 / 应用内 Alt+V 共用统一入口）。
 * 主进程显示独立预览窗并启动 STT。
 */
export function triggerVoiceStart(): Promise<void> {
  const api = requireElectron();
  return api.voice.triggerStart();
}

/**
 * 停止后台语音录音并注入发送（主进程识别完成后注入最近聚焦窗口的 AI 输入框）。
 */
export function triggerVoiceStop(): Promise<void> {
  const api = requireElectron();
  return api.voice.triggerStop();
}

/* =====================================================================
   渲染进程音频采集 —— 对应 window.electron.onVoiceRecordStart 等
   预览窗渲染层通过 getUserMedia 录音，替代主进程 ffmpeg 子进程方案。
   ===================================================================== */

/** 监听开始录音指令（主进程→预览窗渲染） */
export function onVoiceRecordStart(callback: () => void): () => void {
  const api = requireElectron();
  return api.onVoiceRecordStart(callback);
}

/** 监听停止录音指令（主进程→预览窗渲染） */
export function onVoiceRecordStop(callback: () => void): () => void {
  const api = requireElectron();
  return api.onVoiceRecordStop(callback);
}

/** 回传 PCM 数据到主进程（预览窗渲染→主进程） */
export function sendVoiceRecordData(data: number[]): void {
  const api = requireElectron();
  api.sendVoiceRecordData(data);
}

/* =====================================================================
   builtin 模式 Web Speech API —— 对应 window.electron.onVoiceBuiltinStart 等
   主进程在 builtin 模式下通过 IPC 通知预览窗启动 webkitSpeechRecognition，
   渲染层识别完成后回传文本。预览窗（RecordIndicator）订阅此事件。
   ===================================================================== */

/**
 * 监听 builtin 模式启动指令（主进程→预览窗渲染）。
 * 载荷 { language: string } 为 BCP-47 语种标签（如 'zh-CN'）。
 * @returns 取消监听函数
 */
export function onVoiceBuiltinStart(
  callback: (payload: { language: string }) => void,
): () => void {
  const api = requireElectron();
  return api.onVoiceBuiltinStart(callback);
}

/** 回传 builtin 模式识别结果到主进程（预览窗渲染→主进程） */
export function sendVoiceBuiltinResult(text: string): void {
  const api = requireElectron();
  api.sendVoiceBuiltinResult(text);
}

/** 回传 builtin 模式识别错误到主进程（预览窗渲染→主进程） */
export function sendVoiceBuiltinError(error: string): void {
  const api = requireElectron();
  api.sendVoiceBuiltinError(error);
}
