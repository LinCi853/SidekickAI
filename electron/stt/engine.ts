// electron/stt/engine.ts — 语音识别引擎（三路降级链路）
//
// 降级链路：stop() 触发识别时按顺序尝试：
//   1. whisper 本地（whisper.cpp 子进程，需 ggml-tiny.bin 模型）
//   2. Azure Speech（需 API Key）
//   3. 讯飞 WebSocket（需 API Key）
// 任一引擎成功即返回文本并通知前端；全部失败返回空串并发送 STT_ERROR。
//
// 录音由 audio/capture.ts 的 AudioCapture 负责（16kHz mono Float32 PCM）。
// 通过 BrowserWindow.webContents.send 向前端推送 STT_RESULT / STT_ERROR 事件。

import { app, BrowserWindow, net, safeStorage } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import { writeFile, unlink } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { AudioCapture } from '../audio/capture.js'
import { showNotification } from '../notify.js'
import { IPC_CHANNELS } from '../shared/types.js'
import { getVoiceConfig } from '../store/voice-store.js'
import { aiProviderStore, deriveAudioEndpoint } from '../store/ai-provider-store.js'
import type { CustomAIProvider } from '../shared/chat.types.js'
import { convertTraditionalToSimplified } from './chinese-convert.js'
import { WHISPER_CLI_BINARIES } from './binary-resolver.js'

/** whisper 模型 id 到 ggml 文件名的映射（与 voice-ipc.ts / download 流程共享） */
export const WHISPER_MODEL_FILES: Record<string, string> = {
  'whisper-tiny': 'ggml-tiny.bin',
  'whisper-base': 'ggml-base.bin',
  'whisper-small': 'ggml-small.bin',
}

/** 反向映射：文件名 → modelId（用于扫描磁盘时识别已有模型） */
const FILE_TO_MODEL_ID: Record<string, 'whisper-tiny' | 'whisper-base' | 'whisper-small'> = {
  'ggml-tiny.bin': 'whisper-tiny',
  'ggml-base.bin': 'whisper-base',
  'ggml-small.bin': 'whisper-small',
}

/** 扫描 userData/models/ 目录，返回所有已下载的模型 id 列表 */
export function listDownloadedModelIds(): Array<'whisper-tiny' | 'whisper-base' | 'whisper-small'> {
  try {
    const modelsDir = path.join(app.getPath('userData'), 'models')
    if (!existsSync(modelsDir)) return []
    const files = readdirSync(modelsDir)
    const ids: Array<'whisper-tiny' | 'whisper-base' | 'whisper-small'> = []
    for (const f of files) {
      const id = FILE_TO_MODEL_ID[f]
      if (id) ids.push(id)
    }
    return ids
  } catch (err) {
    console.warn('[voice] 扫描 models 目录失败:', err)
    return []
  }
}

/** 检查指定 modelId 的文件是否实际存在（不依赖 cfg） */
export function isModelFileExists(modelId: string): boolean {
  const file = WHISPER_MODEL_FILES[modelId]
  if (!file) return false
  try {
    const p = path.join(app.getPath('userData'), 'models', file)
    return existsSync(p)
  } catch {
    return false
  }
}

/** whisper 标准输入采样率 */
const SAMPLE_RATE = 16000

/** 错误日志截断长度（Mimo ASR 响应体较长，保留 300 字符） */
const ERROR_LOG_MAX_LEN = 300
/** 错误日志截断长度（OpenAI Whisper API 响应体较短，保留 200 字符） */
const ERROR_LOG_MAX_LEN_SHORT = 200

/**
 * 语音识别引擎
 *
 * 三路降级：whisper 本地 -> Azure -> 讯飞。
 * MVP 阶段：
 * - whisper 本地：完整实现（检查模型 + 调用 whisper-cli）
 * - Azure / 讯飞：仅检查 API Key，无 Key 则跳过；完整 SDK 调用留作 TODO
 */
export class SttEngine {
  private recording = false
  private currentEngine: 'whisper' | 'azure' | 'xunfei' | null = null
  private audioCapture = new AudioCapture()
  /** 发起本次录音的窗口，用于把识别结果发回正确窗口（多窗口下避免错位） */
  private sourceWindow: BrowserWindow | null = null
  /**
   * 最近一次录音的失败原因（人类可读）。由 notifyError 设置，被 main.ts 读取以生成
   * 精确的预览窗提示文本，避免误报 "whisper-cli 未下载"（实际可能是 getUserMedia 失败）。
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
      // 关键修复：根据不同失败场景给出精确的错误信息，避免误导
      // - 渲染进程模式失败（getUserMedia 拒绝/设备不可用）→ 提示麦克风权限
      // - whisper-cli 缺失 → 提示下载
      // - 通用 → 提示"未采集到音频数据"
      const config = getVoiceConfig()
      if (config.sttMode === 'download') {
        const binDir = path.join(app.getPath('userData'), 'bin')
        const names = ['whisper-cli.exe', 'whisper.exe', 'main.exe']
        const hasCli = names.some((n) => existsSync(path.join(binDir, n)))
        if (!hasCli) {
          this.lastError = 'whisper-cli 引擎未下载，请在设置中下载'
        } else {
          this.lastError = '未采集到音频数据（请检查麦克风权限与设备）'
        }
      } else {
        this.lastError = '未采集到音频数据（请检查麦克风权限与设备）'
      }
      console.warn('[SttEngine]', this.lastError)
      this.notifyError(this.lastError)
      return ''
    }

    // 读取语音配置，根据 sttMode 选择引擎
    const config = getVoiceConfig()
    console.log('[SttEngine] 当前识别模式:', config.sttMode)

    // builtin 模式由渲染层 Web Speech API 处理，主进程 stop() 不应被调用。
    // 异常路径兜底：返回空串并记录日志，避免误报 "whisper-cli 引擎未下载"。
    // 正常流程下 main.ts stopBackgroundVoice 会在 builtin 模式调用 stopCaptureOnly()
    // 释放麦克风，然后通过 IPC 通知渲染层执行 webkitSpeechRecognition。
    if (config.sttMode === 'builtin') {
      console.warn('[SttEngine] builtin 模式应在渲染层通过 Web Speech API 处理，主进程 stop() 收到调用，返回空串')
      this.lastError = 'builtin 模式由渲染层处理，主进程不应执行识别'
      return ''
    }

    // ---- 引擎选择 ----
    // 1. download: whisper 本地
    //    用户明确选 whisper 时（download），不自动降级到 AI 模式，即便 AI 模式已配置。原因：
    //    - 用户选择的引擎是 Whisper Small，输出预期是纯转写文本
    //    - 自动降级到 Mimo 会出现 "(speaking in foreign language)" 等占位符
    //    - 应该让用户清楚地知道 whisper 不可用，而不是悄悄换引擎
    let whisperFailed = false
    if (config.sttMode === 'download') {
      try {
        this.currentEngine = 'whisper'
        const text = await this.recognizeWithWhisper(pcm)
        if (text) {
          this.notifyResult(text)
          return text
        }
        whisperFailed = true
      } catch (err) {
        console.error('[SttEngine] whisper 识别失败:', err)
        whisperFailed = true
      }
    }

    // 2. ai: 自定义 AI 接入（OpenAI 兼容 API）
    //    仅在用户显式选择 ai 模式时使用，不再作为 whisper 的自动 fallback
    if (config.sttMode === 'ai') {
      try {
        this.currentEngine = 'azure'
        const text = await this.recognizeWithAiApi(pcm, { providerId: config.aiProvider, language: config.language })
        if (text) {
          this.notifyResult(text)
          return text
        }
      } catch (err) {
        console.error('[SttEngine] AI API 识别失败:', err)
      }
    } else if (whisperFailed && config.sttMode === 'download') {
      // whisper 模式失败时给出明确的本地引擎错误（不再静默切到 Mimo）
      const binDir = path.join(app.getPath('userData'), 'bin')
      const names = WHISPER_CLI_BINARIES
      const hasCli = names.some((n) => existsSync(path.join(binDir, n)))
      if (!hasCli) {
        this.lastError = 'whisper-cli 引擎未下载，请在设置中下载（注意：模型和引擎是两部分，都需要下载）'
      } else {
        this.lastError = 'whisper 本地识别失败，请检查模型文件或重新下载'
      }
      console.error('[SttEngine]', this.lastError)
      this.notifyError(this.lastError)
      return ''
    }

    // 3. local: 自定义本地识别软件
    if (config.sttMode === 'local') {
      try {
        const text = await this.recognizeWithLocalExe(pcm, config)
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
    let modeHint: string
    if (config.sttMode === 'download') {
      // 检查 bin 目录是否有 whisper-cli
      const binDir = path.join(app.getPath('userData'), 'bin')
      const possibleNames = WHISPER_CLI_BINARIES
      const hasCli = possibleNames.some((n) => existsSync(path.join(binDir, n)))
      const hasModel = (() => {
        const modelFileMap: Record<string, string> = {
          'whisper-tiny': 'ggml-tiny.bin',
          'whisper-base': 'ggml-base.bin',
          'whisper-small': 'ggml-small.bin',
        }
        const modelFile = modelFileMap[config.downloadModel || 'whisper-tiny'] || 'ggml-tiny.bin'
        return existsSync(path.join(app.getPath('userData'), 'models', modelFile))
      })()
      if (!hasCli && !hasModel) {
        modeHint = 'whisper-cli 引擎和模型均未下载，请在设置中下载'
      } else if (!hasCli) {
        modeHint = 'whisper-cli 引擎未下载，请在设置中下载「识别引擎」'
      } else if (!hasModel) {
        modeHint = '模型未下载，请在设置中下载模型'
      } else {
        modeHint = 'whisper-cli 执行失败，请检查引擎版本'
      }
    } else {
      modeHint = '请检查语音识别设置'
    }
    this.notifyError('语音识别失败：' + modeHint)
    return ''
  }

  /**
   * 仅停止录音（释放麦克风），不执行识别。
   * 用于 builtin 模式：主进程不识别，识别由渲染层 Web Speech API 完成。
   * 调用后 recording 置 false，PCM 数据被丢弃。
   * 关键：必须先释放 getUserMedia 持有的麦克风，否则 webkitSpeechRecognition 无法获取设备。
   */
  async stopCaptureOnly(): Promise<void> {
    if (!this.recording) {
      console.warn('[SttEngine] 未在录音中，stopCaptureOnly 直接返回')
      return
    }
    this.recording = false
    try {
      // 停止 audioCapture（发送 VOICE_RECORD_STOP 到渲染层，等待 PCM 回传后释放麦克风）
      // PCM 数据被丢弃——builtin 模式的识别结果来自渲染层 Web Speech，不需要这段音频
      await this.audioCapture.stop()
      console.log('[SttEngine] stopCaptureOnly 完成，麦克风已释放')
    } catch (err) {
      console.error('[SttEngine] stopCaptureOnly 停止录音失败:', err)
    }
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
  // 引擎 1：whisper 本地（whisper.cpp）
  // ------------------------------------------------------------------------

  /**
   * whisper 本地识别
   * - 根据 downloadModel 配置选择模型文件（tiny/base/small）
   * - 模型目录：userData/models/
   * - 存在：将 PCM 写入临时 WAV，调用 whisper-cli 识别
   * - 不存在：跳过并提示用户下载模型
   */
  private async recognizeWithWhisper(pcm: Float32Array): Promise<string> {
    const config = getVoiceConfig()
    // 模型 id 到文件名的映射（ggml 格式）
    const modelFileMap: Record<string, string> = {
      'whisper-tiny': 'ggml-tiny.bin',
      'whisper-base': 'ggml-base.bin',
      'whisper-small': 'ggml-small.bin',
    }
    const modelId = config.downloadModel || 'whisper-tiny'
    const modelFile = modelFileMap[modelId] || 'ggml-tiny.bin'
    const modelPath = path.join(app.getPath('userData'), 'models', modelFile)

    if (!existsSync(modelPath)) {
      console.info('[SttEngine] whisper 模型不存在，跳过本地识别:', modelPath)
      console.info('[SttEngine] 请在设置的「轻量级下载」中下载模型以启用本地离线识别')
      return ''
    }

    // 写入临时 WAV 供 whisper-cli 读取
    const wavPath = path.join(
      app.getPath('temp'),
      `ai-window-stt-${Date.now()}.wav`,
    )
    try {
      const wavBuf = this.float32ToWav(pcm, SAMPLE_RATE)
      await writeFile(wavPath, wavBuf)
    } catch (err) {
      console.error('[SttEngine] 写入临时 WAV 失败:', err)
      return ''
    }

    try {
      // 优先尝试 whisper-rs（内嵌 Rust 绑定，无需外部二进制）
      // 用 createRequire 避免 Rollup 静态分析 import('whisper-rs')
      try {
        const { createRequire } = await import('module')
        const require = createRequire(import.meta.url)
        const whisperRs = require('whisper-rs')
        const Whisper = whisperRs.Whisper || whisperRs.default
        if (Whisper) {
          const whisper = new Whisper(modelPath)
          // whisper-rs 暂未支持直接传 language 参数；多语种识别由模型自动判断
          const result = typeof whisper.transcribeFile === 'function'
            ? whisper.transcribeFile(wavPath)
            : (typeof whisper.transcribe === 'function' ? whisper.transcribe(wavPath) : '')
          if (result && result.trim()) {
            return result.trim()
          }
        }
      } catch (err) {
        // whisper-rs 未安装或调用失败，回退到 whisper-cli
        console.log('[SttEngine] whisper-rs 不可用，回退到 whisper-cli')
      }

      // 回退：whisper-cli 外部二进制
      return await this.runWhisperCli(modelPath, wavPath)
    } finally {
      await unlink(wavPath).catch(() => {
        /* 忽略临时文件清理失败 */
      })
    }
  }

  /**
   * 调用 whisper.cpp 二进制（whisper-cli）识别 WAV
   * -nt：不输出时间戳  -np：无进度条，仅输出纯文本
   */
  private runWhisperCli(modelPath: string, wavPath: string): Promise<string> {
    return new Promise((resolve) => {
      // 优先查找 userData/bin/ 下下载的 whisper-cli，回退到 PATH 中的系统安装
      // whisper.cpp v1.7.x 重命名了二进制：main → whisper-cli，兼容多种命名
      const possibleNames = WHISPER_CLI_BINARIES
      const binDir = path.join(app.getPath('userData'), 'bin')
      let binary = ''
      for (const name of possibleNames) {
        const full = path.join(binDir, name)
        if (existsSync(full)) {
          binary = full
          break
        }
      }
      // 未在 userData/bin 找到，回退到 PATH 中查找
      if (!binary) {
        binary = possibleNames[0] // 让 spawn 尝试 PATH 查找
      }
      const binaryExists = path.isAbsolute(binary) ? existsSync(binary) : false
      console.log('[SttEngine] whisper-cli 路径:', binary, '(exists:', binaryExists, path.isAbsolute(binary) ? '' : '[PATH 回退模式]', ')')
      console.log('[SttEngine] bin 目录内容:', existsSync(binDir) ? readdirSync(binDir) : '目录不存在')
      // 关键：传入语种参数 -l <lang>，避免 whisper 把中文识别为英文/其他语种
      // 语言码：whisper.cpp 使用 ISO 639-1（zh / en / ja / ko / auto）
      // auto 时不传 -l，让 whisper 自动检测
      // 关键修复：之前误用了不存在的 `config` 变量，导致 ReferenceError: config is not defined
      // 改为内联调 getVoiceConfig() 读取
      const voiceCfg = getVoiceConfig()
      const lang = (voiceCfg.language || 'auto').toLowerCase()
      const langCodeMap: Record<string, string> = {
        zh: 'zh',
        'zh-cn': 'zh',
        en: 'en',
        ja: 'ja',
        ko: 'ko',
        fr: 'fr',
        de: 'de',
        es: 'es',
        ru: 'ru',
      }
      const langCode = langCodeMap[lang] || (lang === 'auto' ? '' : lang)
      const args: string[] = ['-m', modelPath, '-f', wavPath, '-nt', '-np']
      if (langCode) {
        args.push('-l', langCode)
        console.log(`[SttEngine] whisper-cli 语种参数: -l ${langCode}`)
      } else {
        console.log('[SttEngine] whisper-cli 使用自动语种检测')
      }

      const proc = spawn(binary, args, { windowsHide: true, env: process.env })
      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      proc.on('error', (err) => {
        // 二进制不存在（ENOENT）
        console.error(
          `[SttEngine] whisper-cli 不可用 (${err.message})，请在设置中下载 whisper-cli 引擎`,
        )
        resolve('')
      })

      proc.on('exit', (code) => {
        if (code !== 0) {
          console.error(
            `[SttEngine] whisper-cli 退出码 ${code}: ${stderr.slice(-512)}`,
          )
          resolve('')
          return
        }
        // 繁→简转换：whisper.cpp 多语种模型对中文音频常输出繁体
        resolve(convertTraditionalToSimplified(stdout.trim()))
      })
    })
  }

  // ------------------------------------------------------------------------
  // 引擎 2：自定义 AI 接入（OpenAI 兼容 Speech-to-Text API）
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
      return this.recognizeWithMimoAsr(pcm, provider, config.language)
    }

    // 标准 OpenAI Whisper 格式：multipart/form-data 上传 WAV
    return this.recognizeWithOpenAiWhisper(pcm, provider, deriveAudioEndpoint(provider.apiEndpoint, 'transcriptions'), config.language)
  }

  /**
   * Mimo ASR 识别（通过 chat completions 接口）
   * 将音频转为 Base64 data URL，作为 input_audio 内容发送
   * 使用 Electron net.request 走应用代理设置（system/custom/direct）
   *
   * 关键修复（解决 net::ERR_INVALID_ARGUMENT）：
   * - **不要**手动设置 Content-Length：net.request 会自行计算并切分 chunked，
   *   手动设置一旦与实际写入字节数不一致（哪怕差 1 字节）就会抛出 ERR_INVALID_ARGUMENT。
   * - body 统一转为 Buffer 后再 req.write()，避免字符串编码歧义。
   *
   * 关键修复（解决"中文输出 (speaking in foreign language) 占位符"）：
   * - mimo-v2.5-asr 是基于 chat completions 的大模型，对 asr_options 异常敏感。
   *   之前传 `asr_options.language: 'zh'` + `asr_options.task: 'transcribe'` 时，
   *   模型把它当成"翻译到中文"任务；当音频被判别为非中文（如噪声、静音）时
   *   输出 "(speaking in foreign language)" 等占位文本。
   * - 关键洞察：**完全不传 asr_options**，仅靠 system + user 强提示词引导模型做转写。
   * - 加 temperature=0 让输出更确定，避免模型自由发挥。
   *
   * 关键修复（解决"中文被翻译成英文"）：
   * - 本地 Mimo 服务有时是通用 chat 模型，对 system 指令服从度低
   * - 改为"全压 system 提示 + user 消息只发音频"，减少模型把 user 文本当翻译目标的可能
   * - 后处理兜底：若设置语言为中文但输出不含任何中文字符，视为翻译结果丢弃
   */
  private async recognizeWithMimoAsr(
    pcm: Float32Array,
    provider: CustomAIProvider,
    language?: string,
  ): Promise<string> {
    const wavBuf = this.float32ToWav(pcm, SAMPLE_RATE)
    const base64Audio = wavBuf.toString('base64')
    const dataUrl = `data:audio/wav;base64,${base64Audio}`

    // 端点：使用 provider 的 apiEndpoint
    let endpoint = provider.apiEndpoint
    if (!endpoint) {
      throw new Error('未配置 AI 语音识别端点，请在设置中配置或切换到本地识别模式')
    }
    // 如果端点不以 /chat/completions 结尾，自动补全
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.replace(/\/$/, '') + '/chat/completions'
    }

    // 输入过大警告：Mimo API 通常支持 ~25MB 输入，115200 样本的 base64 大约 300KB，远低于上限
    const AUDIO_DURATION_WARN_MS = 5 * 60 * 1000
    const audioDurationMs = (pcm.length / SAMPLE_RATE) * 1000
    if (audioDurationMs > AUDIO_DURATION_WARN_MS) {
      console.warn(`[SttEngine] 音频时长 ${(audioDurationMs / 1000).toFixed(1)}s 较长，可能超时请耐心等待`)
    }

    // 语言提示：仅作为弱偏好，不传 asr_options.language
    const langNorm = (language || 'auto').toLowerCase()
    const langNameMap: Record<string, string> = {
      zh: '中文（普通话）',
      'zh-cn': '中文（普通话）',
      en: '英文',
      ja: '日文',
      ko: '韩文',
      fr: '法文',
      de: '德文',
      es: '西班牙文',
      ru: '俄文',
      auto: '原声语种（自动判断）',
    }
    const langDesc = langNameMap[langNorm] || `${langNorm}（按该语种转写）`
    const expectChinese = langNorm === 'zh' || langNorm === 'zh-cn' || langNorm === 'auto'

    // system 提示：把"严禁翻译"和"严禁占位符"放在最前面，用最强约束
    // 关键是 system 消息要让模型明确：只输出原话，不输出任何其他东西
    const systemPrompt = [
      '【最高优先级】你是一个语音转写器，不是翻译器。',
      '',
      '用户提供的 audio 是某人说话的录音。',
      `用户的预期输出语种：${langDesc}`,
      '',
      '【绝对禁止】',
      '1. 禁止翻译。说话人说中文就输出中文，说英文就输出英文。绝对不要把中文翻译成英文。',
      '2. 禁止输出 "(speaking in foreign language)"、"[foreign language]"、"无法识别" 等任何占位文本。',
      '3. 禁止添加任何解释、注释、Markdown 标记、引号。',
      '4. 禁止总结、润色、改写、补全。',
      '',
      '【正确做法】',
      '- 听完 audio 后，把听到的原话逐字敲出来，用说话人使用的语种。',
      '- 听不清的部分可以跳过（不写），但不要编造占位符。',
      '- 如果整个 audio 都没听清，就输出一个空字符串。',
      '',
      '【示例】',
      '- audio 是 "你好世界" → 输出 "你好世界"',
      '- audio 是 "Hello world" → 输出 "Hello world"',
      '- audio 是 "你好世界" 且用户要求输出英文 → 输出 "你好世界"（仍是原话，不要翻译成 "Hello world"）',
      '',
      '再次强调：原话转写，不翻译，不润色，不占位。',
    ].join('\n')

    // 关键：user 消息只发音频，不再加 text 指令
    // 原因：部分 chat 模型会把 user 中的文本指令当成"翻译目标语种"来理解
    // 比如 user 是 "请翻译成中文：[audio]" → 模型理解为"把 audio 翻译成中文"
    // 改为只发 audio，让 system 的指令生效
    const requestBody = JSON.stringify({
      model: provider.sttModel || 'mimo-v2.5-asr',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: dataUrl,
                format: 'wav',
              },
            },
          ],
        },
      ],
      temperature: 0,
    })

    return this.httpPostJson(endpoint, requestBody, provider.apiKey, 'Mimo ASR').then(
      (data) => {
        // Mimo ASR 返回 chat completions 格式，文本在 choices[0].message.content
        try {
          const json = JSON.parse(data)
          let text = json.choices?.[0]?.message?.content?.trim() || ''
          console.log('[SttEngine] Mimo ASR 原始返回:', text.slice(0, 200))

          // 兜底 1：清洗模型常见的占位输出
          const placeholders = [
            '(speaking in foreign language)',
            '[speaking in foreign language]',
            '(foreign language)',
            '[foreign language]',
            '(unintelligible)',
            '[unintelligible]',
            '说外语',
            '正在说外语',
            '在用外语说话',
            'speak foreign language',
            'speaking in a foreign language',
            'i cannot transcribe',
            'i can\'t transcribe',
            '无法转录',
            '无法识别',
          ]
          const lower = text.toLowerCase()
          for (const ph of placeholders) {
            if (lower.includes(ph.toLowerCase())) {
              console.warn(`[SttEngine] Mimo ASR 返回占位文本 "${ph}"，视为空结果`)
              return ''
            }
          }

          // 兜底 2：检测"翻译"行为
          // 如果用户期望中文输出（language=zh 或 auto），但返回结果完全不含中文字符，
          // 且包含英文字母 → 高度怀疑是翻译结果，丢弃
          if (expectChinese) {
            const hasChinese = /[\u4e00-\u9fff]/.test(text)
            const hasEnglish = /[a-zA-Z]{3,}/.test(text) // 至少 3 个连续英文字母
            if (!hasChinese && hasEnglish && text.length > 5) {
              console.warn(
                `[SttEngine] Mimo ASR 输出疑似英文翻译（无中文字符），原结果: "${text.slice(0, 100)}"`,
              )
              console.warn('[SttEngine] 提示：Mimo 可能在做翻译而非转写，建议切换到 Whisper Small 引擎')
              return ''
            }
          }

          // 兜底 3：如果输出明显是模型在"自我解释"而非转写
          // 例：返回 "The speaker says: 你好" → 只取冒号后的内容
          // 也覆盖 "字幕：xxx" / "识别结果：xxx" / "转写：xxx" 等中文模型常见的前缀
          const explanationPatterns = [
            /^(the\s+)?speaker\s+(says?|is\s+saying)\s*[:：]\s*/i,
            /^(transcription|转写|识别结果|识别内容|字幕|实时字幕|subtitles?|captions?)\s*[:：]\s*/i,
            /^["「『](.+)["」』]$/, // 整体被引号包住
          ]
          for (const pat of explanationPatterns) {
            const m = text.match(pat)
            if (m && m[1] !== undefined) {
              console.log(`[SttEngine] Mimo ASR 清洗解释性前缀: "${text}" → "${m[1]}"`)
              text = m[1].trim()
              break
            }
          }

          // 兜底 4：繁→简转换（Mimo 对中文也常输出繁体）
          return convertTraditionalToSimplified(text)
        } catch (e) {
          console.error('[SttEngine] Mimo ASR 响应 JSON 解析失败:', e, data.slice(0, 200))
          return ''
        }
      },
    )
  }

  /**
   * 标准 OpenAI Whisper 识别（multipart/form-data 上传 WAV）
   * 使用 Electron net.request 走应用代理设置
   */
  private async recognizeWithOpenAiWhisper(
    pcm: Float32Array,
    provider: CustomAIProvider,
    endpoint: string,
    language?: string,
  ): Promise<string> {
    const wavBuf = this.float32ToWav(pcm, SAMPLE_RATE)
    const model = provider.sttModel || 'whisper-1'

    // 构建 multipart/form-data
    const boundary = '----ai-window-stt-' + Date.now()
    const parts: Buffer[] = []

    // model 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`))
    // file 字段（WAV 音频）
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ))
    parts.push(wavBuf)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)
    return this.httpPostMultipart(endpoint, body, boundary, provider.apiKey, 'OpenAI Whisper').then(
      (data) => {
        try {
          const json = JSON.parse(data)
          // 繁→简转换：Mimo/OpenAI 也有可能输出繁体
          return convertTraditionalToSimplified(json.text?.trim() || '')
        } catch (e) {
          console.error('[SttEngine] OpenAI Whisper 响应 JSON 解析失败:', e, data.slice(0, 200))
          return ''
        }
      },
    )
  }

  /**
   * 通过 Electron net.request 发送 JSON POST 请求，自动走应用代理
   * @param url 完整 URL
   * @param body JSON 字符串或 Buffer
   * @param apiKey 鉴权密钥
   * @param tag 日志标签
   * @returns 响应体字符串
   *
   * 关键修复：不要手动设置 Content-Length（会让 net.request 报 ERR_INVALID_ARGUMENT）。
   * net.request 会自行计算并切分 chunked encoding。
   */
  private httpPostJson(
    url: string,
    body: string | Buffer,
    apiKey: string,
    tag: string,
  ): Promise<string> {
    return new Promise((resolve) => {
      try {
        // 校验 URL 合法性（避免 net.request 报 ERR_INVALID_ARGUMENT）
        let safeUrl: string
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`不支持的协议: ${parsed.protocol}`)
          }
          safeUrl = parsed.toString()
        } catch (e) {
          console.error(`[SttEngine] ${tag} URL 非法: ${url}`, e)
          resolve('')
          return
        }

        const req = net.request({
          method: 'POST',
          url: safeUrl,
          redirect: 'follow',
        })
        req.setHeader('Content-Type', 'application/json')
        req.setHeader('Authorization', `Bearer ${apiKey}`)
        // 关键：不要设置 Content-Length！让 net.request 自动计算
        // 手动设置后一旦与实际写入字节数有差异，Chromium 会抛 ERR_INVALID_ARGUMENT
        this.sendHttpRequest(req, body, tag, resolve)
      } catch (e) {
        console.error(`[SttEngine] ${tag} 请求构造失败:`, e)
        resolve('')
      }
    })
  }

  /**
   * 通过 Electron net.request 发送 multipart/form-data POST 请求
   */
  private httpPostMultipart(
    url: string,
    body: Buffer,
    boundary: string,
    apiKey: string,
    tag: string,
  ): Promise<string> {
    return new Promise((resolve) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`不支持的协议: ${parsed.protocol}`)
        }
        const safeUrl = parsed.toString()

        const req = net.request({
          method: 'POST',
          url: safeUrl,
          redirect: 'follow',
        })
        req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`)
        req.setHeader('Authorization', `Bearer ${apiKey}`)
        // 同样不设置 Content-Length
        this.sendHttpRequest(req, body, tag, resolve)
      } catch (e) {
        console.error(`[SttEngine] ${tag} 请求构造失败:`, e)
        resolve('')
      }
    })
  }

  /**
   * 通用 net.request 发送 + 接收 + 超时
   * 关键修复：body 统一转为 Buffer 后再写入，避免字符串编码歧义导致的 ERR_INVALID_ARGUMENT
   */
  private sendHttpRequest(
    req: Electron.ClientRequest,
    body: string | Buffer,
    tag: string,
    resolve: (value: string) => void,
  ): void {
    const TIMEOUT_MS = 30000
    let timer: NodeJS.Timeout | null = null
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { req.abort() } catch { /* ignore */ }
      resolve(value)
    }

    timer = setTimeout(() => {
      console.error(`[SttEngine] ${tag} 请求超时 (${TIMEOUT_MS}ms)`)
      finish('')
    }, TIMEOUT_MS)

    req.on('response', (res) => {
      const statusCode = res.statusCode
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8')
        if (statusCode !== 200) {
          console.error(
            `[SttEngine] ${tag} 返回 ${statusCode}: ${data.slice(0, ERROR_LOG_MAX_LEN)}`,
          )
          finish('')
          return
        }
        finish(data)
      })
      res.on('error', (err: Error) => {
        console.error(`[SttEngine] ${tag} 响应流错误:`, err.message)
        finish('')
      })
    })

    req.on('error', (err: Error) => {
      // 记录详细错误便于诊断 ERR_INVALID_ARGUMENT 等问题
      console.error(`[SttEngine] ${tag} 请求失败: ${err.message} (code: ${(err as any).code ?? 'unknown'})`)
      finish('')
    })

    try {
      // 统一转为 Buffer：避免 string 编码歧义（不同编码模式下字节数差异会触发 ERR_INVALID_ARGUMENT）
      const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
      // 调试日志：输出 body 大小和 base64 data URL 长度，便于排查超长请求
      if (process.env.NODE_ENV !== 'production' || process.env.VOICE_DEBUG) {
        const dataUrlMatch = typeof body === 'string' ? body.match(/data:audio\/wav;base64,([^"]*)/) : null
        if (dataUrlMatch) {
          console.log(`[SttEngine] ${tag} 发送请求: url=${req}, body 总长=${bodyBuf.length} 字节, base64 音频长度=${dataUrlMatch[1].length}`)
        } else {
          console.log(`[SttEngine] ${tag} 发送请求: body 总长=${bodyBuf.length} 字节`)
        }
      }
      req.write(bodyBuf)
      req.end()
    } catch (e) {
      console.error(`[SttEngine] ${tag} 写入请求体失败:`, e)
      finish('')
    }
  }

  // ------------------------------------------------------------------------
  // 引擎 3：本地识别软件
  // ------------------------------------------------------------------------

  /**
   * 本地识别软件
   * 将 PCM 写入临时 WAV，调用用户配置的可执行文件，读取 stdout 作为识别结果。
   * localExePath: 可执行文件路径
   * localArgs: 启动参数（支持 {wav} 占位符替换为 WAV 文件路径）
   *
   * 中文适配策略：
   * - 用户已显式填写 localArgs：完全尊重，不做任何修改
   * - localArgs 为空时：注入默认中文语种参数 `-l <lang>`，兼容主流本地引擎：
   *   - whisper.cpp / whisper-cli：-l zh 指定识别语种
   *   - FunASR：--lang zh / 同名参数
   *   - vosk：通过 -l 传递语言（少数版本支持）
   * - 用户可在设置中手动覆盖 localArgs 以适配其他语种或自定义参数
   */
  private async recognizeWithLocalExe(
    pcm: Float32Array,
    config: { localExePath: string; localArgs: string; language?: string },
  ): Promise<string> {
    if (!config.localExePath) {
      console.info('[SttEngine] 本地识别软件路径未配置，跳过')
      return ''
    }
    if (!existsSync(config.localExePath)) {
      console.error('[SttEngine] 本地识别软件不存在:', config.localExePath)
      return ''
    }

    const wavPath = path.join(app.getPath('temp'), `ai-window-stt-local-${Date.now()}.wav`)
    try {
      const wavBuf = this.float32ToWav(pcm, SAMPLE_RATE)
      await writeFile(wavPath, wavBuf)
    } catch (err) {
      console.error('[SttEngine] 写入临时 WAV 失败:', err)
      return ''
    }

    // ---- 参数组装 ----
    // ISO 639-1 简写 -> whisper.cpp / FunASR 通用语种码（仅在 auto 时不传 -l）
    const language = (config.language || 'zh').toLowerCase()
    const langCodeMap: Record<string, string> = {
      zh: 'zh',
      'zh-cn': 'zh',
      en: 'en',
      ja: 'ja',
      ko: 'ko',
      fr: 'fr',
      de: 'de',
      es: 'es',
      ru: 'ru',
    }
    const langCode = langCodeMap[language] || (language === 'auto' ? '' : language)

    let argsString: string
    if (config.localArgs && config.localArgs.trim()) {
      // 用户已显式填写：原样使用，不做任何修改（避免覆盖高级用户的调参）
      argsString = config.localArgs
      console.log(`[SttEngine] 本地识别使用用户自定义参数: ${argsString}`)
    } else if (langCode) {
      // 用户未填：注入中文（默认）语种参数，{wav} 占位符稍后替换
      argsString = `-l ${langCode} {wav}`
      console.log(`[SttEngine] 本地识别注入默认中文语种参数: ${argsString}`)
    } else {
      // auto 模式且未填 args：仅传音频路径
      argsString = '{wav}'
      console.log('[SttEngine] 本地识别使用 auto 模式（无 -l 参数）')
    }

    return new Promise<string>((resolve) => {
      const args = argsString
        .split(/\s+/)
        .filter(Boolean)
        .map((a) => a.replace('{wav}', wavPath))
      console.log('[SttEngine] 本地识别执行命令:', config.localExePath, args.join(' '))
      const proc = spawn(config.localExePath, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('error', (err) => {
        console.error('[SttEngine] 本地识别软件启动失败:', err.message)
        resolve('')
      })
      proc.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[SttEngine] 本地识别软件退出码 ${code}: ${stderr.slice(-256)}`)
        }
        // 繁→简转换：本地引擎也可能输出繁体
        resolve(convertTraditionalToSimplified(stdout.trim()))
      })
    }).finally(() => {
      void unlink(wavPath).catch(() => {})
    })
  }

  // ------------------------------------------------------------------------
  // 私有辅助
  // ------------------------------------------------------------------------

  /**
   * 读取密钥
   * MVP：优先从环境变量读取（无需额外存储后端）。
   * 生产实现：通过 electron-store 读取 safeStorage 加密的 Buffer，再 decryptString。
   * 此处检查 safeStorage 可用性以对齐后续加密存储路径。
   */
  private readSecret(key: string): string {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[SttEngine] safeStorage 不可用，密钥回退到环境变量')
      }
      // 环境变量名：stt.azure.apiKey -> STT_AZURE_APIKEY
      const envName = key.toUpperCase().replace(/\./g, '_')
      return process.env[envName] ?? ''
    } catch (err) {
      console.error(`[SttEngine] 读取密钥失败 (${key}):`, err)
      return ''
    }
  }

  /** 通知前端识别结果 */
  private notifyResult(text: string): void {
    try {
      const win = (this.sourceWindow && !this.sourceWindow.isDestroyed())
        ? this.sourceWindow
        : BrowserWindow.getAllWindows()[0]
      win?.webContents.send(IPC_CHANNELS.STT_RESULT, text)
      // 语音识别完成系统通知（仅在有识别文本时）
      if (text && text.trim()) {
        showNotification('语音识别完成', text.length > 60 ? text.slice(0, 60) + '…' : text)
      }
    } catch (err) {
      console.error('[SttEngine] 发送 STT_RESULT 失败:', err)
    }
  }

  /** 通知前端识别错误 */
  private notifyError(message: string): void {
    try {
      const win = (this.sourceWindow && !this.sourceWindow.isDestroyed())
        ? this.sourceWindow
        : BrowserWindow.getAllWindows()[0]
      win?.webContents.send(IPC_CHANNELS.STT_ERROR, message)
    } catch (err) {
      console.error('[SttEngine] 发送 STT_ERROR 失败:', err)
    }
  }

  /**
   * 将 Float32 PCM 转换为 16kHz mono 16-bit WAV Buffer
   * 供 whisper-cli 直接读取（whisper.cpp 接受标准 WAV 输入）。
   */
  private float32ToWav(pcm: Float32Array, sampleRate: number): Buffer {
    const numChannels = 1
    const bytesPerSample = 2
    const blockAlign = numChannels * bytesPerSample
    const byteRate = sampleRate * blockAlign
    const dataSize = pcm.length * bytesPerSample
    const buffer = Buffer.alloc(44 + dataSize)

    // RIFF 头
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    // fmt 块
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16) // 子块大小
    buffer.writeUInt16LE(1, 20) // 音频格式：1 = PCM
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(16, 34) // 位深度
    // data 块
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)

    // Float32 [-1.0, 1.0] -> Int16 [-32768, 32767]
    let offset = 44
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      buffer.writeInt16LE(Math.round(s * 32767), offset)
      offset += 2
    }
    return buffer
  }
}
