// electron/stt/engine.ts — 语音识别引擎
//
// 支持两种模式：
//   1. ai: 自定义 AI 接入（OpenAI 兼容 Speech-to-Text API）
//   2. local: 自定义本地识别软件（用户配置的可执行文件）
//
// 录音由 audio/capture.ts 的 AudioCapture 负责（16kHz mono Float32 PCM）。
// 识别结果通过 VOICE_INJECT_AND_SEND 路径注入渲染层（非 STT_RESULT/STT_ERROR 通道）。

import { BrowserWindow } from 'electron'
import { AudioCapture } from '../audio/capture.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { getVoiceConfig } from '../store/voice-store.js'
import { aiProviderStore, deriveAudioEndpoint } from '../store/ai-provider-store.js'
import { SAMPLE_RATE } from './constants.js'
import { recognizeWithMimoAsr } from './ai-mimo.js'
import { recognizeWithOpenAiWhisper } from './ai-whisper.js'
import { recognizeWithLocalExe } from './local-exe.js'

/**
 * 语音识别引擎
 *
 * 支持两种模式：
 * - ai: 自定义 AI 接入（OpenAI 兼容 Speech-to-Text API）
 * - local: 自定义本地识别软件（用户配置的可执行文件）
 */
export class SttEngine {
  private recording = false
  private currentEngine: 'ai' | 'local' | null = null
  private audioCapture = new AudioCapture()
  /** 发起本次录音的窗口，用于把识别结果发回正确窗口（多窗口下避免错位） */
  private sourceWindow: BrowserWindow | null = null
  /**
   * 最近一次录音的失败原因（人类可读）。由 notifyError 设置，被 main.ts 读取以生成
   * 精确的预览窗提示文本。
   */
  private lastError: string = ''

  /**
   * 读取最近一次录音的失败原因（已 trim）。空串表示没有错误。
   * main.ts stopBackgroundVoice 会消费这个字段用于展示准确错误信息。
   */
  getLastError(): string {
    return this.lastError
  }

  /** 清空最近错误（每次 start 调用前清空） */
  clearLastError(): void {
    this.lastError = ''
  }

  /** 设置渲染进程录音窗口（预览窗），null 则回退到 ffmpeg */
  setRendererWindow(win: BrowserWindow | null): void {
    this.audioCapture.setRendererWindow(win)
    /**
     * 注册"快速失败"回调：渲染层在 start 阶段就报错（getUserMedia 拒绝 / 设备不存在），
     * 立即把错误信息推给预览窗 UI，让用户松手之前就看到失败原因。
     * 之前只更新内部 lastError，UI 在松手前停留在「正在聆听」假状态。
     *
     * 通过最新 PreviewWindow 引用 + IPC_CHANNELS.PREVIEW_UPDATE 通道发送，
     * 与正常 showPreview() 走完全相同的路径，确保 PreviewView 收到事件。
     */
    if (win) {
      this.previewWindow = win
    }
    this.audioCapture.setOnFail((reason: string) => {
      this.lastError = reason
      this.notifyPreviewUpdate({ status: 'done', text: reason })
    })
  }

  /** 缓存当前预览窗引用（用于快速失败时主动推送） */
  private previewWindow: BrowserWindow | null = null

  /**
   * 向预览窗推送状态更新（与 main.ts showPreview 走相同 IPC 通道）
   * 静默吞掉所有异常，避免影响主流程
   */
  private notifyPreviewUpdate(payload: {
    status: 'recording' | 'transcribing' | 'done' | 'sent'
    text: string
  }): void {
    try {
      const win = this.previewWindow
      if (!win || win.isDestroyed()) return
      win.webContents.send(IPC_CHANNELS.PREVIEW_UPDATE, payload)
    } catch (e) {
      console.warn('[SttEngine] 推送预览窗状态失败:', e)
    }
  }

  /** 流式识别部分结果回调（由 main.ts 注入，用于实时推送已识别的文本） */
  private partialResultCallback: ((text: string) => void) | null = null

  /**
   * 设置流式识别部分结果回调。
   * 在识别过程中，引擎可多次调用回调推送已识别的部分文本。
   */
  setPartialResultCallback(callback: ((text: string) => void) | null): void {
    this.partialResultCallback = callback
  }

  /**
   * 向预览窗推送流式识别部分结果。
   * 静默吞掉所有异常，避免影响主流程
   */
  private notifyPartialResult(text: string): void {
    try {
      if (this.partialResultCallback) {
        this.partialResultCallback(text)
      }
      const win = this.previewWindow
      if (!win || win.isDestroyed()) return
      win.webContents.send(IPC_CHANNELS.PREVIEW_PARTIAL, { text })
    } catch (e) {
      console.warn('[SttEngine] 推送部分结果失败:', e)
    }
  }

  /** 开始录音 */
  async start(): Promise<void> {
    // getFocusedWindow 是同步的，必须在任何 await 之前调用，否则焦点可能已切换
    this.sourceWindow = BrowserWindow.getFocusedWindow()
    if (this.recording) {
      console.warn('[SttEngine] 已在录音中，忽略重复 start')
      return
    }
    // 每次 start 清空错误缓存，确保 getLastError 反映本次录音的真实情况
    this.clearLastError()
    try {
      await this.audioCapture.start()
      this.recording = true
      this.currentEngine = null
      console.info('[SttEngine] 开始录音')
    } catch (err) {
      console.error('[SttEngine] 启动录音失败:', err)
      this.recording = false
      this.lastError = '启动录音失败：' + (err instanceof Error ? err.message : String(err))
      this.notifyError(this.lastError)
      throw err
    }
  }

  /**
   * 停止录音并执行识别
   * @returns 识别文本（全部失败时返回空串）
   */
  async stop(): Promise<string> {
    if (!this.recording) {
      console.warn('[SttEngine] 未在录音中，stop 直接返回空串')
      return ''
    }
    this.recording = false

    // 停止录音，获取 PCM 数据
    let pcm: Float32Array
    try {
      pcm = await this.audioCapture.stop()
    } catch (err) {
      console.error('[SttEngine] 停止录音失败:', err)
      this.lastError = '停止录音失败：' + (err instanceof Error ? err.message : String(err))
      this.notifyError(this.lastError)
      return ''
    }

    if (pcm.length === 0) {
      this.lastError = '未采集到音频数据（请检查麦克风权限与设备）'
      console.warn('[SttEngine]', this.lastError)
      this.notifyError(this.lastError)
      return ''
    }

    // 读取语音配置，根据 sttMode 选择引擎
    const config = getVoiceConfig()
    console.log('[SttEngine] 当前识别模式:', config.sttMode)

    // ---- 引擎选择 ----
    // 1. ai: 自定义 AI 接入（OpenAI 兼容 API）
    if (config.sttMode === 'ai') {
      try {
        this.currentEngine = 'ai'
        const text = await this.recognizeWithAiApi(pcm, { providerId: config.aiProvider, language: config.language })
        if (text) {
          this.notifyResult(text)
          return text
        }
      } catch (err) {
        console.error('[SttEngine] AI API 识别失败:', err)
      }
    }

    // 2. local: 自定义本地识别软件
    if (config.sttMode === 'local') {
      try {
        const text = await recognizeWithLocalExe(pcm, config)
        if (text) {
          this.notifyResult(text)
          return text
        }
      } catch (err) {
        console.error('[SttEngine] 本地识别软件失败:', err)
      }
    }

    // 全部失败
    this.currentEngine = null
    this.notifyError('语音识别失败：请检查语音识别设置')
    return ''
  }

  /** 清理资源（应用退出时调用） */
  cleanup(): void {
    try {
      this.recording = false
      this.currentEngine = null
      // AudioCapture 无持久资源，临时文件已在 stop 中删除
    } catch (err) {
      console.error('[SttEngine] cleanup 异常:', err)
    }
  }

  /**
   * 测试当前 AI 接入配置连通性。
   * 发送 0.3s 静音样本，验证能正常请求并解析。
   * 返回 { ok: boolean, message: string, text?: string } 便于设置页展示
   */
  async testAiProvider(providerId: string): Promise<{ ok: boolean; message: string; text?: string }> {
    const provider = aiProviderStore.get(providerId)
    if (!provider) {
      return { ok: false, message: '供应商不存在' }
    }
    if (!provider.apiKey) {
      return { ok: false, message: 'AI API Key 未配置' }
    }
    // 0.3s 静音 Float32Array
    const pcm = new Float32Array(Math.floor(SAMPLE_RATE * 0.3))
    try {
      const text = await this.recognizeWithAiApi(pcm, { providerId: provider.id })
      if (text) {
        return { ok: true, message: '连接成功', text }
      }
      return { ok: false, message: '请求成功但返回为空（端点可能不支持 input_audio 格式）' }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: '请求失败：' + msg }
    }
  }

  // ------------------------------------------------------------------------
  // 引擎 1：自定义 AI 接入（OpenAI 兼容 Speech-to-Text API）
  // ------------------------------------------------------------------------

  /**
   * 自定义 AI 接入识别
   * 支持两种模式：
   * 1. Mimo ASR（mimo-v2.5-asr）：通过 chat completions 接口，使用 input_audio 内容类型
   * 2. 标准 OpenAI Whisper：通过 /v1/audio/transcriptions 接口上传 WAV 文件
   * 自动根据模型名判断使用哪种模式。
   */
  private async recognizeWithAiApi(
    pcm: Float32Array,
    config: { providerId: string; language?: string },
  ): Promise<string> {
    const provider = aiProviderStore.get(config.providerId)
    if (!provider) {
      throw new Error('供应商不存在')
    }
    if (!provider.apiKey) {
      console.info('[SttEngine] AI API Key 未配置，跳过 AI 接入识别')
      return ''
    }

    const model = provider.sttModel || 'whisper-1'

    // Mimo ASR 模型使用 chat completions 格式（input_audio 内容类型）
    if (model.toLowerCase().includes('mimo')) {
      return recognizeWithMimoAsr(pcm, provider, config.language)
    }

    // 标准 OpenAI Whisper 格式：multipart/form-data 上传 WAV
    return recognizeWithOpenAiWhisper(pcm, provider, deriveAudioEndpoint(provider.apiEndpoint, 'transcriptions'), config.language)
  }

  /** 通知前端识别结果（STT_RESULT 无 preload listener，暂为 no-op） */
  private notifyResult(_text: string): void {
    // STT_RESULT IPC 通道无 preload 监听方，识别结果通过 VOICE_INJECT_AND_SEND 路径注入
  }

  /** 通知前端识别错误（STT_ERROR 无 preload listener，暂为 no-op） */
  private notifyError(_message: string): void {
    // STT_ERROR IPC 通道无 preload 监听方，错误信息通过 lastError getter 读取
  }
}
