// electron/audio/capture.ts — 音频采集器
//
// 双模式录音：
// 1. 渲染进程模式（优先）：通过预览窗渲染层的 getUserMedia + MediaRecorder 录音，
//    无需安装 ffmpeg，跨平台一致。主进程通过 IPC 控制。
// 2. ffmpeg 回退模式：通过 child_process 调用系统 ffmpeg（Windows/macOS）或 arecord（Linux）
//    录制 16kHz mono 16-bit PCM，输出 Float32Array。
//
// 输出：16kHz mono Float32Array，范围 [-1.0, 1.0]，可直接喂给 whisper。

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'
import { readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { promisify } from 'util'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../shared/types.js'

const execFileAsync = promisify(execFile)

/** 采样率：whisper 标准输入为 16kHz */
const SAMPLE_RATE = 16000

/**
 * 渲染层"快速失败"回调类型：start 阶段空回包时触发
 * 用于上层（如 SttEngine）把错误信息立即推给预览窗 UI，
 * 避免"明明无法录音但 UI 一直停留在'正在聆听'"的假状态。
 */
export type AudioCaptureFailCallback = (reason: string) => void

/** 音频采集器
 *
 * 双模式录音：
 * - 渲染进程模式：通过 IPC 指挥预览窗渲染层 getUserMedia 录音（优先）
 * - ffmpeg 回退：系统 ffmpeg/arecord 子进程录音（渲染进程不可用时回退）
 *
 * 输出：16kHz mono Float32Array，范围 [-1.0, 1.0]，可直接喂给 whisper。
 */
export class AudioCapture {
  private recording = false
  private process: ChildProcessWithoutNullStreams | null = null
  private tempFile = ''
  /** Windows dshow 设备名缓存（枚举一次后复用，避免每次录音都枚举） */
  private cachedDevice: string | null = null
  /** 渲染进程录音目标窗口（预览窗），设置后优先使用 getUserMedia 录音 */
  private rendererWin: BrowserWindow | null = null
  /**
   * 录音失败标记：渲染层 start 即报错的快速失败路径
   *  - true 时 stop() 立即返回空数组，不再等待 renderer 回包
   *  - 通过 setRecordingFailed() / clearRecordingFailed() 维护
   * 修复"UI 一直显示正在聆听但实际没录到音"的假状态问题
   */
  private recordingFailed = false
  /** 渲染层 fail 回调（用于 stop() 感知快速失败） */
  private failHandler: ((_e: unknown, data: number[] | Float32Array) => void) | null = null
  /** 上层订阅的"快速失败"回调（用于把错误信息立刻推给预览窗） */
  private onFailCallback: AudioCaptureFailCallback | null = null

  /**
   * 注册"快速失败"回调：渲染层 start 阶段返回空数据时，会以人类可读 reason 字符串调用。
   * 同一时刻只能有一个订阅者，重复注册会覆盖。
   */
  setOnFail(cb: AudioCaptureFailCallback | null): void {
    this.onFailCallback = cb
  }

  /** 设置渲染进程录音窗口（预览窗），null 则回退到 ffmpeg */
  setRendererWindow(win: BrowserWindow | null): void {
    this.rendererWin = win
  }

  /** 是否正在录制 */
  get isRecording(): boolean {
    return this.recording
  }

  /**
   * 解析 Windows dshow 音频输入设备名。
   * 通过 ffmpeg -list_devices 枚举 dshow 设备，取第一个 audio 设备；
   * 失败（ffmpeg 不可用 / 超时 / 无设备）时安全回退到 'Microphone'。
   * 结果缓存到 cachedDevice，后续调用直接复用。
   */
  private async resolveWinAudioDevice(): Promise<string> {
    if (this.cachedDevice) return this.cachedDevice
    // 默认回退值
    let device = 'Microphone'
    try {
      // ffmpeg -list_devices 总以非零码退出，但设备列表写入 stderr；
      // 即便 execFileAsync reject，错误对象上仍带 stdout/stderr 缓冲。
      let output = ''
      try {
        const r = await execFileAsync('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { timeout: 5000 })
        output = (r.stderr || '') + (r.stdout || '')
      } catch (e: unknown) {
        const err = e as { stderr?: string; stdout?: string }
        output = ((err?.stderr || '') + (err?.stdout || ''))
      }
      if (output) {
        // dshow 设备列表格式：[dshow @ ...] "设备名" (audio)，或 "DirectShow audio devices" 段
        const lines = output.split(/\r?\n/)
        let inAudio = false
        for (const line of lines) {
          if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue }
          if (/DirectShow video devices/i.test(line)) { inAudio = false; continue }
          if (inAudio) {
            const m = line.match(/"([^"]+)"\s*\((?:audio|input)\)/) || line.match(/"([^"]+)"/)
            if (m && m[1]) { device = m[1]; break }
          }
        }
      } else {
        console.warn('[audio-capture] 枚举 dshow 设备失败（ffmpeg 不可用或超时），回退到 Microphone')
      }
    } catch (e) {
      console.warn('[audio-capture] 枚举 dshow 设备失败，回退到 Microphone:', (e as Error).message)
    }
    this.cachedDevice = device
    return device
  }

  /**
   * 开始录音
   * 优先使用渲染进程 getUserMedia 录音；无渲染窗口时回退到 ffmpeg。
   * 重复调用安全：已在录音时忽略。
   *
   * 新增"快速失败"机制：渲染层 getUserMedia 失败时，会在 start 阶段立即通过
   * sendVoiceRecordData([]) 上报（PreviewView.tsx 的 catch 路径）。
   * start() 端会监听这个早期回包并标记 recordingFailed=true，
   * 这样后续 stop() 立即返回空，不再傻等 10s 超时。
   */
  async start(): Promise<void> {
    if (this.recording) {
      console.warn('[AudioCapture] 已在录音中，忽略重复 start')
      return
    }
    // 每次 start 重置失败标记
    this.recordingFailed = false
    this.clearFailListener()

    // ---- 渲染进程模式（优先）----
    if (this.rendererWin && !this.rendererWin.isDestroyed()) {
      const win = this.rendererWin
      try {
        // 等待渲染层加载完成（首次创建预览窗时可能仍在加载）
        // 使用 did-finish-load + 超时兜底，避免 isLoading 状态不一致导致的死等
        await new Promise<void>((resolve, reject) => {
          const wc = win.webContents
          const timer = setTimeout(() => {
            wc.removeListener('did-finish-load', onLoad)
            reject(new Error('渲染进程加载超时（3s）'))
          }, 3000)
          const onLoad = () => {
            clearTimeout(timer)
            resolve()
          }
          if (wc.isLoading()) {
            wc.once('did-finish-load', onLoad)
          } else {
            // 已加载完成：延迟 50ms 确保 preload / React 已初始化（IPC 监听器已注册）
            clearTimeout(timer)
            setTimeout(resolve, 50)
          }
        })
        win.webContents.send(IPC_CHANNELS.VOICE_RECORD_START)
        this.recording = true
        this.tempFile = ''
        console.info('[AudioCapture] 渲染进程录音已启动')

        // 启动快速失败监听：渲染层若在 getUserMedia / 解码阶段失败，
        // 会立即 sendVoiceRecordData([]) 上报。这里监听后标记 recordingFailed=true，
        // 让 stop() 不再等待正常回包。
        this.installFailListener(win)

        return
      } catch (err) {
        console.error('[AudioCapture] 渲染进程录音启动失败，回退到 ffmpeg:', err)
        this.clearFailListener()
        this.recordingFailed = false
        // 继续走 ffmpeg 回退
      }
    }

    // ---- ffmpeg 回退模式 ----
    this.tempFile = path.join(tmpdir(), `ai-window-rec-${Date.now()}.wav`)

    const platform = process.platform
    let command: string
    let args: string[]

    if (platform === 'win32') {
      // Windows: ffmpeg dshow 采集默认麦克风（枚举设备名，失败回退到 'Microphone'）
      const device = await this.resolveWinAudioDevice()
      command = 'ffmpeg'
      args = [
        '-y',
        '-f', 'dshow',
        '-i', `audio=${device}`,
        '-ar', String(SAMPLE_RATE),
        '-ac', '1',
        '-sample_fmt', 's16',
        this.tempFile,
      ]
    } else if (platform === 'darwin') {
      // macOS: ffmpeg avfoundation，":0" 为默认音频输入设备
      command = 'ffmpeg'
      args = [
        '-y',
        '-f', 'avfoundation',
        '-i', ':0',
        '-ar', String(SAMPLE_RATE),
        '-ac', '1',
        '-sample_fmt', 's16',
        this.tempFile,
      ]
    } else {
      // Linux: arecord（ALSA），输出 16kHz mono 16-bit WAV
      command = 'arecord'
      args = [
        '-q',
        '-r', String(SAMPLE_RATE),
        '-f', 'S16_LE',
        '-c', '1',
        this.tempFile,
      ]
    }

    try {
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      // 收集 stderr 用于诊断（ffmpeg 正常日志走 stderr，非错误）
      let stderrBuf = ''
      this.process.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString()
        // 防止无限增长，仅保留尾部
        if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048)
      })

      // 抑制 stdin 的异步 error 事件（进程已退出时 write 'q' 可能触发）
      this.process.stdin?.on('error', (e) => {
        console.warn('[audio-capture] stdin 错误:', e)
      })

      this.process.on('error', (err) => {
        // 子进程无法启动（如命令不存在）
        console.error(`[AudioCapture] 启动 ${command} 失败: ${err.message}`)
        console.error(
          '[AudioCapture] 请确认系统已安装 ffmpeg（Windows/macOS）或 alsa-utils/arecord（Linux）',
        )
        this.recording = false
        this.process = null
      })

      this.process.on('exit', (code, signal) => {
        // 仅在主动录音期间的非正常退出记录日志
        if (code !== 0 && code !== null && this.recording) {
          console.error(
            `[AudioCapture] ${command} 异常退出 code=${code} signal=${signal}`,
          )
          console.error(`[AudioCapture] stderr: ${stderrBuf.slice(-512)}`)
        }
      })

      this.recording = true
    } catch (err) {
      console.error('[AudioCapture] 启动录音失败:', err)
      this.recording = false
      this.process = null
      throw new Error(
        `启动录音失败: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 停止录音并返回 16kHz mono Float32 PCM
   *
   * 渲染进程模式：发送 VOICE_RECORD_STOP IPC，等待渲染层回传 PCM 数据。
   * ffmpeg 模式：优雅终止子进程（stdin 'q' 或 SIGINT），读取 WAV 文件解析为 Float32。
   */
  /**
   * 安装"快速失败"监听器：渲染层若 sendVoiceRecordData([])，立即标记失败。
   * 与 stop() 的真正回包监听器不同，本监听只关心"早期"空回包（renderer 启动就报错）。
   */
  private installFailListener(win: BrowserWindow): void {
    this.clearFailListener()
    const handler = (_e: unknown, data: number[] | Float32Array) => {
      // 早期空回包 → 标记失败
      const arr = data instanceof Float32Array ? data : new Float32Array(data)
      if (arr.length === 0) {
        console.warn('[AudioCapture] 渲染层快速失败回包（start 阶段），标记 recordingFailed')
        this.recordingFailed = true
        // 触发上层回调，让 UI 立刻显示错误（不再傻等 Alt+V 松开）
        const cb = this.onFailCallback
        if (cb) {
          try {
            cb('录音启动失败：浏览器拒绝麦克风权限或无可用输入设备')
          } catch (e) {
            console.warn('[AudioCapture] onFailCallback 调用异常:', e)
          }
        }
      } else {
        // 正常有数据的情况可能是 PreviewView 的 onstop 触发的提前回包，
        // 这种情况让 stop() 正常处理即可。
      }
    }
    this.failHandler = handler
    ipcMain.on(IPC_CHANNELS.VOICE_RECORD_DATA, handler as (...args: unknown[]) => void)
  }

  /** 移除"快速失败"监听器 */
  private clearFailListener(): void {
    if (this.failHandler) {
      try {
        ipcMain.removeListener(IPC_CHANNELS.VOICE_RECORD_DATA, this.failHandler as (...args: unknown[]) => void)
      } catch {
        /* ignore */
      }
      this.failHandler = null
    }
  }

  /**
   * 停止录音并返回 16kHz mono Float32Array。
   * ffmpeg 模式：优雅终止子进程（stdin 'q' 或 SIGINT），读取 WAV 文件解析为 Float32。
   *
   * 修复：当 recordingFailed 已被标记（renderer 启动即失败），stop() 立即返回空，
   * 不再发送 VOICE_RECORD_STOP 也不挂起等待 10s。
   */
  async stop(): Promise<Float32Array> {
    if (!this.recording) {
      return new Float32Array(0)
    }
    this.recording = false
    // 启动失败快路径：直接返回空，不再通知渲染层（renderer 已经在报错了）
    if (this.recordingFailed) {
      console.warn('[AudioCapture] 录音已被标记失败，stop() 直接返回空')
      this.clearFailListener()
      this.recordingFailed = false
      return new Float32Array(0)
    }

    // ---- 渲染进程模式 ----
    if (this.rendererWin && !this.rendererWin.isDestroyed() && !this.tempFile) {
      const win = this.rendererWin
      // 清理快速失败监听器（由 stop() 的真正回包监听器接管）
      this.clearFailListener()
      return new Promise<Float32Array>((resolve) => {
        let settled = false
        const handler = (_e: unknown, data: number[] | Float32Array) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ipcMain.removeListener(IPC_CHANNELS.VOICE_RECORD_DATA, handler as (...args: unknown[]) => void)
          const float32 = data instanceof Float32Array ? data : new Float32Array(data)
          console.info(`[AudioCapture] 渲染进程录音完成，收到 ${float32.length} 样本`)
          resolve(float32)
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          ipcMain.removeListener(IPC_CHANNELS.VOICE_RECORD_DATA, handler as (...args: unknown[]) => void)
          console.error('[AudioCapture] 渲染进程录音超时（10s），返回空数据')
          resolve(new Float32Array(0))
        }, 10000)
        ipcMain.on(IPC_CHANNELS.VOICE_RECORD_DATA, handler as (...args: unknown[]) => void)
        win.webContents.send(IPC_CHANNELS.VOICE_RECORD_STOP)
      })
    }

    // ---- ffmpeg 回退模式 ----
    if (!this.process) {
      return new Float32Array(0)
    }

    const proc = this.process
    this.process = null

    try {
      if (process.platform === 'linux') {
        // arecord 响应 SIGINT 优雅退出
        proc.kill('SIGINT')
      } else if (proc.exitCode === null && !proc.killed) {
        // 进程仍在运行时，向 ffmpeg stdin 写入 'q' 触发优雅退出
        proc.stdin?.write('q')
      }

      // 等待进程退出（最多 3 秒，超时强制结束并继续读取已写入数据）
      await this.waitForExit(proc, 3000)
    } catch (err) {
      console.error('[AudioCapture] 停止录音进程失败:', err)
      try {
        proc.kill('SIGKILL')
      } catch (e: unknown) {
        console.warn('[audio-capture] 进程终止失败:', e)
      }
    }

    // 读取并解析 WAV 文件
    try {
      if (!this.tempFile || !existsSync(this.tempFile)) {
        console.error('[AudioCapture] 临时录音文件不存在:', this.tempFile)
        return new Float32Array(0)
      }

      const buf = await readFile(this.tempFile)
      if (buf.length < 44) {
        console.error('[AudioCapture] WAV 文件过小，可能录制失败:', buf.length)
        return new Float32Array(0)
      }

      const float32 = this.parseWavToInt16ThenF32(buf)

      // 清理临时文件
      await unlink(this.tempFile).catch((e: unknown) => {
        console.warn('[audio-capture] 清理临时录音文件失败:', e)
      })

      return float32
    } catch (err) {
      console.error('[AudioCapture] 读取/解析 WAV 失败:', err)
      return new Float32Array(0)
    }
  }

  /**
   * 等待子进程退出
   * 超时后强制 SIGKILL，但仍 resolve（继续读取已写入的部分数据）。
   */
  private waitForExit(
    proc: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch (e: unknown) {
          console.warn('[audio-capture] 进程终止失败:', e)
        }
        resolve()
      }, timeoutMs)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * 解析 WAV 文件为 Float32Array
   * 支持 16-bit signed PCM（little-endian）。跳过 WAV 头，定位 data 块。
   * Int16 样本归一化到 [-1.0, 1.0]。
   */
  private parseWavToInt16ThenF32(buf: Buffer): Float32Array {
    // 校验 RIFF / WAVE 头
    if (
      buf.toString('ascii', 0, 4) !== 'RIFF' ||
      buf.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      console.error('[AudioCapture] 非 WAV 格式（RIFF/WAVE 标识缺失）')
      return new Float32Array(0)
    }

    // 遍历块定位 data 块（标准 WAV 头可能含 fmt/其他块）
    let offset = 12
    let dataStart = -1
    let dataLen = 0
    while (offset + 8 <= buf.length) {
      const chunkId = buf.toString('ascii', offset, offset + 4)
      const chunkSize = buf.readUInt32LE(offset + 4)
      if (chunkId === 'data') {
        dataStart = offset + 8
        dataLen = chunkSize
        break
      }
      // 跳过当前块（含块对齐填充字节）
      offset += 8 + chunkSize + (chunkSize % 2)
    }

    if (dataStart < 0) {
      console.error('[AudioCapture] WAV 未找到 data 块')
      return new Float32Array(0)
    }

    // 若块大小字段未更新（非优雅退出场景），回退到文件末尾
    const end = dataLen > 0 ? Math.min(dataStart + dataLen, buf.length) : buf.length
    const sampleCount = Math.floor((end - dataStart) / 2)
    if (sampleCount <= 0) {
      console.warn('[AudioCapture] WAV data 块无有效样本')
      return new Float32Array(0)
    }

    const result = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      // 16-bit signed -> Float32 归一化
      const sample = buf.readInt16LE(dataStart + i * 2)
      result[i] = sample / 32768
    }
    return result
  }
}
